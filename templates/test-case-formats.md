# Test Case Format Reference

Use this reference when `/write-test-cases` generates test cases. Select the format that matches your upload target.

---

## Format 1: Jira-Style (Zephyr / Xray compatible)

Best for: uploading to Jira as Test issues, linking to feature tickets.

```markdown
**ID:** TC-001
**Title:** User can submit order with valid credit card
**Type:** Happy Path
**Priority:** High

**Preconditions:**
- User is logged in as a standard customer
- At least one item is in the cart

**Test Steps:**
1. Navigate to /checkout
   **Expected:** Checkout page loads with order summary
2. Enter valid card number: 4111111111111111, expiry: 12/26, CVV: 123
   **Expected:** Card fields accept input without error
3. Click "Place Order"
   **Expected:** Order confirmation page displays with order ID

**Test Data:**
- Card number: 4111111111111111 (Stripe test card)
- User: test-user@staging.myapp.com

**Expected Overall Result:** Order is created in the system with status "pending_payment"

**Automatable:** Yes
```

---

## Format 2: ClickUp Tasks

Best for: uploading to ClickUp as tasks with step checklists.

```
Task Name: [Test] User can submit order with valid credit card
Description:
  Type: Happy Path | Priority: High
  Preconditions: User is logged in; cart has items.

Checklist "Test Steps":
  [ ] 1. Navigate to /checkout → checkout page loads
  [ ] 2. Enter valid card (4111...) → no errors shown
  [ ] 3. Click Place Order → confirmation page with order ID
  [ ] RESULT: Order created in system with status pending_payment

Tags: test-case, TICKET-ID, happy-path
```

---

## Format 3: BDD / Gherkin

Best for: documentation, linking to automation frameworks (Cucumber, Behave, SpecFlow).

```gherkin
Feature: Order Checkout
  As a logged-in customer
  I want to submit an order with a valid credit card
  So that my purchase is processed

  Background:
    Given I am logged in as a standard customer
    And I have at least one item in my cart

  Scenario: Successfully submit order with valid credit card
    When I navigate to "/checkout"
    Then I should see the checkout page with an order summary
    When I enter card number "4111111111111111", expiry "12/26", CVV "123"
    And I click "Place Order"
    Then I should see the order confirmation page
    And the order should be created with status "pending_payment"

  Scenario: Reject order with expired credit card
    When I navigate to "/checkout"
    And I enter card number "4111111111111111", expiry "01/20", CVV "123"
    And I click "Place Order"
    Then I should see an error "Card has expired"
    And no order should be created
```

---

## Format 4: Robot Framework

Best for: teams using Robot Framework for automation.

```robotframework
*** Settings ***
Library    SeleniumLibrary
Library    RequestsLibrary

*** Test Cases ***
User Can Submit Order With Valid Credit Card
    [Documentation]    Happy path: order submission with valid card
    [Tags]    happy-path    checkout    TC-001
    Given User Is Logged In As Standard Customer
    And Cart Contains At Least One Item
    When User Navigates To Checkout
    Then Checkout Page Should Load With Order Summary
    When User Enters Valid Credit Card    4111111111111111    12/26    123
    And User Clicks Place Order
    Then Order Confirmation Page Should Display
    And Order Status Should Be    pending_payment

*** Keywords ***
User Is Logged In As Standard Customer
    Open Browser    ${BASE_URL}/login    Chrome
    Input Text      name:email          ${TEST_EMAIL}
    Input Password  name:password       ${TEST_PASSWORD}
    Click Button    type:submit
    Wait Until Page Contains Element    id:dashboard
```

---

## Format 5: Plain Markdown Table

Best for: documentation, pull request descriptions, spreadsheet import.

| ID | Title | Type | Priority | Preconditions | Steps | Expected Result | Automatable |
|----|-------|------|----------|---------------|-------|-----------------|-------------|
| TC-001 | User can submit order with valid credit card | Happy Path | High | Logged in; cart not empty | 1. Go to /checkout 2. Enter valid card 3. Click Place Order | Confirmation page shown; order created | Yes |
| TC-002 | Error shown for expired credit card | Negative | High | Logged in; cart not empty | 1. Go to /checkout 2. Enter expired card 3. Click Place Order | Error message: "Card has expired"; no order created | Yes |
