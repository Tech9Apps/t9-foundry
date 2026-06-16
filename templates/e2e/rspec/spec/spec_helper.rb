require 'dotenv/load'
require_relative 'support/prod_guard'
require_relative 'support/data_factory'

RSpec.configure do |config|
  # ── Layer 5 production guard ──────────────────────────────────────────────
  config.before(:suite) do
    base_url = ENV.fetch('BASE_URL') do
      raise "BASE_URL is not set. Copy .env.test.example to .env.test, " \
            "fill in your staging URL, then run: source .env.test"
    end
    ProdGuard.validate_not_production(base_url)
    puts "\n✓ QA Harness — test environment: #{base_url}\n"
  end

  # ── Data cleanup ──────────────────────────────────────────────────────────
  config.after(:suite) do
    DataFactory.cleanup_all
  end

  # ── General settings ──────────────────────────────────────────────────────
  config.order = :random
  config.filter_run_when_matching :focus

  # Disable monkey-patching (use `RSpec.describe` not top-level `describe`)
  config.disable_monkey_patching!

  # Print slow examples (anything over 0.05s gets flagged)
  config.profile_examples = 10

  config.expect_with :rspec do |expectations|
    expectations.include_chain_clauses_in_custom_matcher_descriptions = true
  end

  config.mock_with :rspec do |mocks|
    mocks.verify_partial_doubles = true
  end
end
