# Gmail OAuth Setup

This MVP uses Gmail read-only access.

## Google Cloud Setup

1. Create or choose a Google Cloud project.
2. Enable the Gmail API.
3. Configure the OAuth consent screen.
4. Create an OAuth client for a web application.
5. Add this redirect URI:

```text
http://localhost:3000/oauth/google/callback
```

6. Add your Gmail account as a test user if the app is in testing mode.
7. Copy the client id and client secret into `.env`.

## Local Environment

```sh
cp .env.example .env
```

Required values:

```text
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/google/callback
WEB_ORIGIN=http://localhost:5173
```

Optional values:

```text
SYNC_MESSAGE_LIMIT=50
SYNC_QUERY=newer_than:90d -in:chats
```

In development, the API runs on `http://localhost:3000` and the React PWA runs
on `http://localhost:5173`. Start OAuth from the React app, not by opening the
callback URL directly.

## Scope

The app requests:

```text
https://www.googleapis.com/auth/gmail.readonly
```

This lets SaneMail read Gmail messages and settings. It does not let SaneMail
modify Gmail.

## Production Notes

Before public Gmail launch:

- Complete Google's required verification for restricted Gmail scopes.
- Encrypt OAuth tokens at rest.
- Publish privacy policy, terms, and in-product data-use disclosure.
- Implement account disconnect and data deletion against production storage.
- Confirm model-provider data handling satisfies Google's Limited Use rules.
