# Mingle Chat

Mingle is a static website for GitHub Pages. It does not need an app server to stay online. Supabase Free provides account sign-in, persistent chat storage, and real-time message updates.

## Set up the free database

1. Create a Supabase project on the [Supabase Dashboard](https://supabase.com/dashboard). Its free plan has storage, usage, and inactivity limits; review the current plan before inviting people.
2. In **Authentication → Providers → Email**, keep email/password sign-in enabled and turn **Confirm email** off if you want new accounts to start chatting immediately. Set the minimum password length to 8.
3. Open **SQL Editor**, paste all of [`supabase/schema.sql`](./supabase/schema.sql), and run it. Run the updated file again after upgrading an existing Mingle deployment. The migration keeps existing profiles and messages, adds email lookup, archiving, and message edit/delete support, and refreshes the database functions and policies.
4. Open **Project Settings → API** and copy the **Project URL** and the **publishable key** (or legacy `anon` key). Put those values in [`server/wwwroot/supabase-config.js`](./server/wwwroot/supabase-config.js):

   ```js
   export const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
   export const SUPABASE_ANON_KEY = "YOUR-PUBLISHABLE-OR-ANON-KEY";
   ```

   This key is designed to be public in a browser app. **Never use or publish a `service_role` or secret key.** The database's row-level security policies protect user records and messages.

## Publish the website

1. Push the `main` branch to GitHub. The included GitHub Actions workflow installs the browser dependencies, builds the static site, and deploys it to GitHub Pages.
2. In the GitHub repository, open **Settings → Pages** and choose **GitHub Actions** as the build and deployment source if it is not already selected.
3. Wait for the **Deploy Mingle to GitHub Pages** workflow to complete. GitHub shows the website address under **Settings → Pages**. Open it over HTTPS and share that address with the people you want to chat with.

GitHub Pages is available for public repositories on GitHub Free; private-repository Pages availability depends on the account plan. Making this repository public is a separate choice and is not done automatically.

## Use Mingle

- Create an account with a name, email, unique 10-digit mobile number, and a password of at least 8 characters. Neither the phone number nor email is verified when email confirmation is disabled.
- Find contacts by their exact registered mobile number or email address. A successful lookup shows both details to the signed-in user, so only share an email or number you are comfortable making discoverable to people who know it.
- Existing accounts can continue logging in with their old 10-digit number and password. Add an email in your profile to switch to email login and enable password recovery.
- Messages are stored in Supabase and delivered live while the site is open. Chats can be archived; messages can be edited for 15 minutes or deleted for everyone. If the live connection drops, an open conversation periodically refreshes.
- Optional browser notifications work while the website is open in the background and notification permission is granted. Notifications when the app/browser is fully closed are not configured.
- The optional PIN chat lock and its PIN verifier are stored only in this browser/device. This is a convenience screen lock, not server-side access control or message encryption; do not rely on it to protect data from someone with access to the account or browser storage.

Passwords are handled by Supabase Auth, not saved in website files. Messages are not end-to-end encrypted, and the Supabase project owner can access the database. Supabase Free has storage, usage, and inactivity limits; check its current limits before relying on it for important conversations.

Existing Supabase accounts and messages are kept by the schema migration. Accounts and messages stored only in the old self-hosted server are not migrated automatically.

## Build locally

Install Node.js 22 or later, set the Supabase values above, and run these commands from this folder:

```powershell
npm ci
npm run build
```

The static website is generated in `dist`. Deploy that folder to any static HTTPS host. The site needs internet access to connect to Supabase.

## Android wrapper

The optional Android WebView wrapper can open the same deployed HTTPS website; it does not host a server or database. Build it from this folder with the .NET 10 Android workload:

```powershell
dotnet workload install android
dotnet publish .\android-app\Mingle.Android.csproj -c Release -f net10.0-android -p:AndroidPackageFormat=apk
```

The APK is written under `android-app\bin\Release\net10.0-android\publish`. The Mingle 1.1 APK opens the GitHub Pages website automatically; previously installed versions keep their saved website address.
