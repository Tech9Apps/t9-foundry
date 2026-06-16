require_relative 'qa_config_loader'

module ProdGuard
  # Layer 5 production guard — raises if base_url matches any production pattern.
  # Called in spec_helper.rb before the suite runs.
  #
  # @param base_url [String] the test environment URL to validate
  # @param patterns [Array<String>, nil] regex patterns identifying production URLs;
  #   loaded from qa-config.json automatically when nil
  def self.validate_not_production(base_url, patterns: nil)
    raise ArgumentError, 'base_url is required' if base_url.nil? || base_url.empty?

    patterns ||= begin
      qa = QAConfigLoader.load
      qa.dig('productionProtection', 'prodUrlPatterns') || []
    end

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
  end
end
