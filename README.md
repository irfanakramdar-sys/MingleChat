# Mingle Chat

Mingle is a static website for GitHub Pages. It does not need an app server to stay online. Supabase Free provides account sign-in, persistent chat storage, and real-time message updates.

## Set up the free database

1. Create a Supabase project on the [Supabase Dashboard](https://supabase.com/dashboard). Its free plan has storage, usage, and inactivity limits; review the current plan before inviting people.
2. In **Authentication → Providers → Email**, keep email/password sign-in enabled and turn **Confirm email** off. Mingle uses a generated, non-deliverable email address behind each 10-digit mobile number, so no email or SMS verification is sent. Set the minimum password length to 8.
3. Open **SQL Editor**, paste all of [`supabase/schema.sql`](./supabase/schema.sql), and run it. This creates the profiles and messages tables, private row-level security policies, account lookup limits, and the Realtime publication.
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

- Create an account with a name, a unique 10-digit mobile number, and a password of at least 8 characters. Phone-number ownership is not verified.
- Share the generated 8-digit account number. Someone can enter it to find the profile and start a chat.
- Messages are stored in the Supabase database and delivered live while the site is open. If a live connection drops, an open conversation periodically refreshes.
- Optional browser notifications work while the website is open in the background and notification permission is granted. Background push delivery is not included.

Passwords are handled by Supabase Auth, not saved in the website files. This sign-in method does not collect an email address, so password recovery is unavailable; users who forget a password cannot receive a reset email. Profile lookup displays the mobile number to an authenticated user who has the matching account number. Messages are not end-to-end encrypted, and the Supabase project owner can access the database.

Accounts and messages from the old self-hosted server are not migrated automatically. Everyone needs to create a new account on the Supabase-backed site.

## Build locally

Install Node.js 20 or later, set the Supabase values above, and run these commands from this folder:

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

The APK is written under `android-app\bin\Release\net10.0-android\publish`. Enter the GitHub Pages website address the first time you open it.
