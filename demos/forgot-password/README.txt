Unlock Account User Demo v3

How to open:
1. Unzip this folder.
2. Double-click index.html.
3. Click Login to simulate the locked-account message.
4. The Unlock My Account button appears only after the red locked-account message is shown.
5. Click Unlock My Account.

New in v3:
- The unlock popup auto-populates with the account portal Username value from the login page.
- If the login username is an email address, the popup strips the domain and uses username only.
  Example: demo.user@example.com becomes testuser.
- If a user types/pastes an email address inside the popup, the domain is automatically removed.
- Success and failure messages include the username.
- After success, the locked message and Unlock button disappear, the password field clears, and focus returns to password.

Demo users:
- testuser
  Returns success: Account Unlocked.
- lockeduser
  Returns success: Account Unlocked.
- faileduser
  Returns failure: Unable to Unlock Account.
- Any other username
  Returns: username could not be found.

Production note:
This is a user-facing demo. It does not expose Admin screens.
In production, the frontend should submit the username to a secured backend/API.
The backend should validate the user, perform the unlock/permission assignment, audit the request, and return success or failure.
No permission assignment logic should exist in the frontend.

