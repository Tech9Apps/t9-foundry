# Runs tests/fixtures/guard-cases.json through the Ruby runtime guard. Prints "OK" or each mismatch.
require 'json'
root = File.expand_path('../..', __dir__)
require File.join(root, 'templates/e2e/rspec/spec/support/prod_guard')
t = JSON.parse(File.read(File.join(root, 'tests/fixtures/guard-cases.json')))
bad = 0
t['cases'].each do |c|
  %w[enforce warn].each do |mode|
    cfg = t['configs'][c['config']]
    r = ProdGuard.decide(c['url'], mode: mode, prod_url_patterns: cfg['prodUrlPatterns'], allowed_url_patterns: cfg['allowedUrlPatterns'],
                                    block_on_suspicious_urls: cfg['blockOnSuspiciousUrls'], test_environment_base_url: cfg['testEnvironmentBaseUrl'])
    if r[:decision] != c['expect'][mode] || r[:reason] != c['reason']
      bad += 1
      puts "MISMATCH #{mode} #{c['url'].inspect} -> #{r[:decision]} #{r[:reason]} | expected #{c['expect'][mode]} #{c['reason']}"
    end
  end
end
puts bad.zero? ? 'OK' : "#{bad} mismatches"
exit(bad.zero? ? 0 : 1)
