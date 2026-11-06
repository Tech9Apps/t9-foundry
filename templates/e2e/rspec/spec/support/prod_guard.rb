require_relative 'qa_config_loader'

# Layer 5 production guard.
#
# The decision procedure is a port of hooks/lib/url-guard.js (the reference): tests/fixtures/guard-cases.json is run against every
# implementation (shell hooks, TypeScript, Python, Ruby), so a change here must be made there too or that table fails.
#
#   1. a configured prodUrlPatterns regex matching ANY normalized form of the URL -> block (both modes)
#   2. blockOnSuspiciousUrls == false -> allow (enforce mode never overrides this opt-out)
#   3. a host that cannot be verified (variables, escapes, odd characters, not http(s)) -> block in enforce, warn otherwise
#   4. a known tracker/registry host, an allowedUrlPatterns match, or the configured test environment's own host -> allow
#   5. a host that is recognizably NOT production (a staging/test/dev/qa/... LABEL, a reserved or private address) -> allow
#   6. anything else is an unrecognized host: block in enforce (fail closed), warn otherwise
module ProdGuard
  NONPROD_TOKENS = %w[staging stage stg test testing dev develop development qa uat sandbox sbx preprod preview integration].freeze
  PROD_TOKENS = %w[prod production live prd].freeze
  RESERVED_TLDS = %w[test example invalid localhost local].freeze
  DOC_HOSTS = %w[example.com example.org example.net].freeze
  BUILTIN_EXEMPT_HOSTS = %w[github.com githubusercontent.com gitlab.com bitbucket.org dev.azure.com visualstudio.com api.clickup.com
                            atlassian.net atlassian.com registry.npmjs.org npmjs.org npmjs.com registry.yarnpkg.com pypi.org
                            pythonhosted.org rubygems.org nodejs.org].freeze

  Parsed = Struct.new(:scheme, :host, :port, :v6, :path, :verifiable)

  def self.on_label_boundary?(host, domain)
    host == domain || host.end_with?(".#{domain}")
  end

  def self.parse_url(url)
    m = %r{\A(https?)://([^/?#]*)([^?#]*)}i.match(url.to_s)
    return nil unless m

    scheme = m[1].downcase
    authority = m[2]
    return nil if authority.include?('\\') # browsers and curl disagree about "\": do not guess

    at = authority.rindex('@')
    hostport = at ? authority[(at + 1)..-1] : authority
    port = ''
    v6 = false
    if hostport.start_with?('[')
      b = /\A\[([^\]]*)\](?::(\d*))?\z/.match(hostport)
      return nil unless b

      host = b[1].downcase
      port = b[2] || ''
      v6 = true
    else
      b = /\A([^:]*)(?::(\d*))?\z/.match(hostport)
      return nil unless b

      host = b[1].downcase.sub(/\.+\z/, '') # "host." and "host" are the same host
      port = b[2] || ''
    end
    return nil if host.empty?

    path = m[3].empty? ? '/' : m[3] # query and fragment are not part of what a pattern may match
    verifiable = v6 ? host.match?(/\A[0-9a-f:.]+\z/) : host.match?(/\A[a-z0-9._-]+\z/)
    Parsed.new(scheme, host, port, v6, path, verifiable)
  end

  # inet_aton semantics: 1-4 parts, each decimal / 0x-hex / 0-octal, the last part fills the remaining bytes.
  def self.to_ipv4(host)
    return nil unless host.match?(/\A[0-9a-fx.]+\z/i)

    parts = host.split('.', -1)
    return nil if parts.length > 4 || parts.any?(&:empty?)

    nums = []
    parts.each do |p|
      if p.match?(/\A0x[0-9a-f]+\z/i) then nums << p.to_i(16)
      elsif p.match?(/\A0[0-7]+\z/) then nums << p.to_i(8)
      elsif p.match?(/\A[0-9]+\z/) then nums << p.to_i(10)
      else return nil
      end
    end
    last = nums[-1]
    room = 2**(8 * (5 - nums.length))
    return nil if nums[0...-1].any? { |n| n > 255 } || last >= room

    value = last
    nums[0...-1].each_with_index { |n, i| value += n * 2**(8 * (3 - i)) }
    [value / 2**24 % 256, value / 2**16 % 256, value / 256 % 256, value % 256].join('.')
  end

  def self.private_v4?(ip)
    a, b = ip.split('.').map(&:to_i)
    a == 127 || a == 10 || a.zero? || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 169 && b == 254)
  end

  def self.private_v6?(host)
    return true if host == '::1'
    return true if host.match?(/\Af[cd][0-9a-f]{2}:/) || host.match?(/\Afe[89ab][0-9a-f]:/)

    mapped = /\A::ffff:(\d+\.\d+\.\d+\.\d+)\z/.match(host)
    ip = mapped && to_ipv4(mapped[1])
    !ip.nil? && private_v4?(ip)
  end

  def self.nonprod_host?(u)
    return private_v6?(u.host) if u.v6

    ip = to_ipv4(u.host)
    return private_v4?(ip) if ip
    return true if u.host == 'localhost' || u.host.end_with?('.localhost')

    labels = u.host.split('.', -1)
    return true if labels.length > 1 && RESERVED_TLDS.include?(labels[-1])
    return true if DOC_HOSTS.any? { |d| on_label_boundary?(u.host, d) }

    # Tokens come from the host's labels WITHOUT its TLD (".dev" is a real TLD, not a staging marker), split on . - _ and compared
    # whole: "devices", "aqua" and "attestation" are not "dev", "qa" and "test".
    tokens = labels[0...-1].join('.').split(/[._-]/).reject(&:empty?)
    return false if tokens.any? { |t| PROD_TOKENS.include?(t) } # "test-prod.acme.com" is production wearing a hat

    tokens.any? { |t| NONPROD_TOKENS.include?(t) }
  end

  # Every form of the URL a production pattern may reasonably be written against.
  def self.candidates(url, u)
    out = [url.to_s]
    hosts = [u.host]
    ip = u.v6 ? nil : to_ipv4(u.host)
    hosts << ip if ip && ip != u.host
    hosts.each do |h|
      hs = u.v6 ? "[#{h}]" : h
      out << "#{u.scheme}://#{hs}#{u.path}" << hs
      out << "#{u.scheme}://#{hs}:#{u.port}#{u.path}" << "#{hs}:#{u.port}" unless u.port.empty?
    end
    out.uniq
  end

  def self.compile(pattern, flags = 0)
    Regexp.new(pattern, flags)
  rescue RegexpError
    nil
  end

  # decide(url, mode:, prod_url_patterns:, allowed_url_patterns:, block_on_suspicious_urls:, test_environment_base_url:)
  #   -> { decision: 'allow' | 'warn' | 'block', reason: String, detail: String? }
  def self.decide(url, cfg = {})
    enforce = cfg[:mode] == 'enforce'
    failing = lambda do |reason, detail = nil|
      { decision: enforce ? 'block' : 'warn', reason: reason, detail: detail }
    end
    u = parse_url(url)

    forms = u && u.verifiable ? candidates(url, u) : [url.to_s]
    (cfg[:prod_url_patterns] || []).each do |pattern|
      re = pattern && !pattern.empty? ? compile(pattern, Regexp::IGNORECASE) : nil # case-insensitive: hosts are
      return { decision: 'block', reason: 'PROD_PATTERN', detail: pattern } if re && forms.any? { |f| re.match?(f) }
    end

    return { decision: 'allow', reason: 'HEURISTIC_DISABLED' } if cfg[:block_on_suspicious_urls] == false

    return failing.call('UNPARSEABLE', 'not an http(s) URL with a plain host') unless u
    return failing.call('UNVERIFIABLE_HOST', 'the host contains a variable, escape, or non-plain character') unless u.verifiable

    return { decision: 'allow', reason: 'EXEMPT_HOST' } if BUILTIN_EXEMPT_HOSTS.any? { |d| on_label_boundary?(u.host, d) }

    shown = u.v6 ? "[#{u.host}]" : u.host
    stripped = "#{u.scheme}://#{shown}#{u.port.empty? ? '' : ":#{u.port}"}#{u.path}" # no userinfo, query or fragment
    (cfg[:allowed_url_patterns] || []).each do |pattern|
      re = pattern && !pattern.empty? ? compile(pattern) : nil # an invalid allow-pattern never exempts anything
      if re && (re.match?(stripped) || re.match?("#{u.scheme}://#{u.host}#{u.path}"))
        return { decision: 'allow', reason: 'ALLOWED_PATTERN', detail: pattern }
      end
    end
    test_env = cfg[:test_environment_base_url] && !cfg[:test_environment_base_url].to_s.empty? ? parse_url(cfg[:test_environment_base_url]) : nil
    return { decision: 'allow', reason: 'TEST_ENV_HOST' } if test_env && test_env.verifiable && test_env.host == u.host

    return { decision: 'allow', reason: 'NONPROD_HOST' } if nonprod_host?(u)

    failing.call('UNRECOGNIZED_HOST')
  end

  # Layer 5 production guard — raises if base_url matches any production pattern, or (in enforce mode) is not recognizably a test
  # environment. Called in spec_helper.rb before the suite runs.
  #
  # Guard mode: with QA_AUTONOMOUS=1 (unattended runs) or productionProtection.mode == "enforce", a URL that is not recognizably
  # non-production raises instead of only warning — a warning nobody reads is not a guard.
  #
  # @param base_url [String] the test environment URL to validate
  # @param patterns [Array<String>, nil] regex patterns identifying production URLs;
  #   loaded from qa-config.json automatically when nil
  def self.validate_not_production(base_url, patterns: nil)
    raise ArgumentError, 'base_url is required' if base_url.nil? || base_url.empty?

    error = QAConfigLoader.error
    if error
      if ENV['QA_AUTONOMOUS'] == '1'
        raise RuntimeError,
              "BLOCKED: qa-config.json could not be read, so the production patterns it holds cannot be applied (#{error}).\n" \
              'Fix the file; unattended runs (QA_AUTONOMOUS=1) do not continue without it.'
      end
      warn "WARNING: qa-config.json could not be read (#{error}); production patterns are NOT being applied."
    end

    config = QAConfigLoader.load
    protection = config['productionProtection'] || {}
    patterns ||= protection['prodUrlPatterns'] || []
    enforce = ENV['QA_AUTONOMOUS'] == '1' || protection['mode'] == 'enforce'

    (patterns || []).each do |pattern|
      warn "WARNING: Skipping invalid production URL pattern: #{pattern}" if pattern && !pattern.empty? && compile(pattern).nil?
    end

    d = decide(base_url,
               mode: enforce ? 'enforce' : 'warn',
               prod_url_patterns: patterns,
               allowed_url_patterns: protection['allowedUrlPatterns'] || [],
               block_on_suspicious_urls: protection['blockOnSuspiciousUrls'] == false ? false : nil,
               test_environment_base_url: (config['environments'] || {})['testEnvironmentBaseUrl'])
    return if d[:decision] == 'allow'

    if d[:reason] == 'PROD_PATTERN'
      raise RuntimeError,
            "BLOCKED: BASE_URL '#{base_url}' matches a production pattern: #{d[:detail]}\n" \
            "Tests must never run against production. " \
            "Update BASE_URL in .env.test to point at your staging environment."
    end

    if d[:decision] == 'block'
      raise RuntimeError,
            "BLOCKED: BASE_URL '#{base_url}' is not recognizably a test environment (#{d[:reason]}) and guard mode is " \
            "'enforce' (QA_AUTONOMOUS=1 or productionProtection.mode).\n" \
            "Set BASE_URL to your staging URL, or add a regex for this URL to " \
            "productionProtection.allowedUrlPatterns in qa-config.json if it is safe."
    end

    warn "WARNING: BASE_URL '#{base_url}' may be a production URL (#{d[:reason]}). " \
         'Configure productionProtection.prodUrlPatterns in qa-config.json to enable strict blocking.'
  end
end
