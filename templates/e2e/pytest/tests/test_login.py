"""
Example e2e test — Login flow (API-level)

These tests exercise the login API directly using the requests library.
For browser-based login tests, use pytest-playwright and follow the same
fixture pattern (the conftest.py fixtures work with pytest-playwright too).

Replace the endpoint paths and expected response shapes with your app's
actual API contract.
"""

import os
import requests


def test_valid_login_returns_token(test_user):
    """Valid credentials should return an auth token."""
    base_url = os.environ["BASE_URL"]
    # TODO: Replace with your app's actual login endpoint and password field
    response = requests.post(
        f"{base_url}/api/auth/login",
        json={"email": test_user["email"], "password": os.environ.get("TEST_USER_PASSWORD", "Test@1234!")},
    )
    assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
    data = response.json()
    assert "token" in data, f"Expected 'token' in response body, got: {data}"


def test_invalid_credentials_returns_401():
    """Wrong password must be rejected with a 401."""
    base_url = os.environ["BASE_URL"]
    response = requests.post(
        f"{base_url}/api/auth/login",
        json={"email": "notauser@example-test.com", "password": "wrongpassword"},
    )
    assert response.status_code == 401, f"Expected 401, got {response.status_code}"


def test_missing_fields_returns_422():
    """Request missing required fields should return a validation error."""
    base_url = os.environ["BASE_URL"]
    response = requests.post(f"{base_url}/api/auth/login", json={})
    assert response.status_code in (400, 422), (
        f"Expected 400 or 422 for missing fields, got {response.status_code}"
    )
