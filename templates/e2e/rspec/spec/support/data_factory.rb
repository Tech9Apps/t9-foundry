require 'faraday'
require 'faraday/json'
require 'securerandom'

module DataFactory
  @registry = []

  class << self
    # ── Entity factories ────────────────────────────────────────────────────

    # Create a test user via the application API and register for cleanup.
    #
    # @param attrs [Hash] attribute overrides merged with defaults
    # @return [Hash] the created user
    def create_user(attrs = {})
      base_url = ENV.fetch('BASE_URL')
      conn = build_connection(base_url)

      defaults = {
        email: "test-#{SecureRandom.hex(4)}@example-test.com",
        role: 'user',
      }
      payload = defaults.merge(attrs)

      # TODO: Replace with your application's user creation endpoint
      response = conn.post('/api/users', payload)
      raise "DataFactory.create_user failed: #{response.status} #{response.body}" unless response.success?

      user = response.body
      @registry << {
        type: 'user',
        id: user['id'],
        cleanup: -> { conn.delete("/api/users/#{user['id']}") rescue nil },
      }
      user
    end

    # Add more factory methods following this pattern:
    #
    # def create_order(attrs = {})
    #   base_url = ENV.fetch('BASE_URL')
    #   conn = build_connection(base_url)
    #   response = conn.post('/api/orders', { ...defaults, **attrs })
    #   raise "..." unless response.success?
    #   order = response.body
    #   @registry << { type: 'order', id: order['id'],
    #                  cleanup: -> { conn.delete("/api/orders/#{order['id']}") rescue nil } }
    #   order
    # end

    # ── Cleanup ─────────────────────────────────────────────────────────────

    # Delete all registered entities in reverse creation order.
    # Called automatically in spec_helper.rb > after(:suite).
    def cleanup_all
      @registry.reverse.each do |entity|
        entity[:cleanup]&.call
      rescue => e
        warn "DataFactory cleanup warning (#{entity[:type]} #{entity[:id]}): #{e}"
      end
      @registry.clear
    end

    def registry
      @registry.dup
    end

    private

    def build_connection(base_url)
      Faraday.new(url: base_url) do |f|
        f.request :json
        f.response :json
        f.adapter Faraday.default_adapter
      end
    end
  end
end
