require 'spec_helper'
require 'faraday'
require 'faraday/json'

RSpec.describe 'Login', type: :feature do
  # Shared connection — all examples in this group use the same base URL
  let(:base_url) { ENV.fetch('BASE_URL') }
  let(:conn) do
    Faraday.new(url: base_url) do |f|
      f.request :json
      f.response :json
      f.adapter Faraday.default_adapter
    end
  end

  # DataFactory creates a fresh user for each example that calls `test_user`.
  # Cleanup happens automatically after the suite via DataFactory.cleanup_all.
  let(:test_user) { DataFactory.create_user }

  describe 'POST /api/auth/login' do
    context 'with valid credentials' do
      it 'returns 200 and an auth token' do
        # TODO: Replace with your app's actual login endpoint and password field
        response = conn.post('/api/auth/login', {
          email: test_user['email'],
          password: ENV.fetch('TEST_USER_PASSWORD', 'Test@1234!'),
        })

        expect(response.status).to eq(200)
        expect(response.body).to have_key('token')
      end
    end

    context 'with invalid credentials' do
      it 'returns 401' do
        response = conn.post('/api/auth/login', {
          email: 'notauser@example-test.com',
          password: 'wrongpassword',
        })

        expect(response.status).to eq(401)
      end
    end

    context 'with missing fields' do
      it 'returns a validation error (400 or 422)' do
        response = conn.post('/api/auth/login', {})

        expect(response.status).to be_in([400, 422])
      end
    end
  end
end
