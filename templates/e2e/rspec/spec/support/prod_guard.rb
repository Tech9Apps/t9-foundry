require_relative 'qa_config_loader'

module ProdGuard
  # Looks like a bare production host (two-label domain), excluding common non-prod prefixes.
  SUSPICIOUS_URL = %r{\Ahttps?://(?!staging\.|test\.|dev\.|qa\.|localhost|127\.0\.0\.1)[a-z0-9-]+\.[a-z]{2,}(?:/|\z)}i.freeze

  # Layer 5 production guard — raises if base_url matches any production pattern.
  # Called in spec_helper.rb before the suite runs.
  #
  # Guard mode: with QA_AUTONOMOUS=1 (unattended runs) or
  # productionProtection.mode == "enforce", a suspicious-looking URL raises instead
  # of only warning — a warning nobody reads is not a guard.
  #
  # @param base_url [String] the test environment URL to validate
  # @param patterns [Array<String>, nil] regex patterns identifying production URLs;
  #   loaded from qa-config.json automatically when nil
  def self.validate_not_production(base_url, patterns: nil)
    raise ArgumentError, 'base_url is required' if base_url.nil? || base_url.empty?

    protection = QAConfigLoader.load['productionProtection'] || {}
    patterns ||= protection['prodUrlPatterns'] || []

    patterns.each do |pattern|
      begin
        if base_url.match?(Regexp.new(pattern))
          raise RuntimeError,
                "BLOCKED: BASE_URL '#{base_url}' matches a production pattern: #{pattern}\n" \
                "Tests must never run against production. " \
                "Update BASE_URL in .env.test to point at your staging environment."
        end
      rescue RegexpError
        warn "WARNING: Skipping invalid production URL pattern: #{pattern}"
      end
    end

    # Heuristic check — an additional layer that still runs once real patterns exist.
    return if protection['blockOnSuspiciousUrls'] == false
    return if allowed_url?(base_url, protection['allowedUrlPatterns'] || [])

    return unless base_url.match?(SUSPICIOUS_URL)

    if ENV['QA_AUTONOMOUS'] == '1' || protection['mode'] == 'enforce'
      raise RuntimeError,
            "BLOCKED: BASE_URL '#{base_url}' looks like a production URL and guard mode is " \
            "'enforce' (QA_AUTONOMOUS=1 or productionProtection.mode).\n" \
            "Set BASE_URL to your staging URL, or add a regex for this URL to " \
            "productionProtection.allowedUrlPatterns in qa-config.json if it is safe."
    end

    warn "WARNING: BASE_URL '#{base_url}' may be a production URL. " \
         'Configure productionProtection.prodUrlPatterns in qa-config.json to enable strict blocking.'
  end

  def self.allowed_url?(base_url, allowed)
    allowed.any? do |pattern|
      begin
        base_url.match?(Regexp.new(pattern))
      rescue RegexpError
        false # an invalid allow-pattern never exempts anything
      end
    end
  end
end
