# Mingle Chat

Mingle is a static website for GitHub Pages. It does not need an app server to stay online. Supabase Free provides account sign-in, persistent chat storage, and real-time message updates.

## Set up the free database

1. Create a Supabase project on the [Supabase Dashboard](https://supabase.com/dashboard). Its free plan has storage, usage, and inactivity limits; review the current plan before inviting people.
2. In **Authentication → Providers → Email**, keep email/password sign-in enabled and turn **Confirm email** off if you want new accounts to start chatting immediately. Set the minimum password length to 8.
3. Open **SQL Editor**, paste all of [`supabase/schema.sql`](./supabase/schema.sql), and run it. Run the updated file again after upgrading an existing Mingle deployment. The migration keeps existing profiles and messages, backfills eligible profiles from existing auth metadata, refreshes the API schema cache, and adds email lookup, archiving, message edit/delete, private photo/video/voice storage, and invite-only communities with topic groups.
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
- Find contacts by their registered 10-digit mobile number without a country code (spaces, periods, hyphens, and an optional local leading 0 are accepted) or email address. The person must have a Mingle account in the same Supabase project. A successful lookup shows both details to the signed-in user, so only share an email or number you are comfortable making discoverable to people who know it.
- Existing accounts can continue logging in with their old 10-digit number and password. Add an email in your profile to switch to email login and enable password recovery.
- Messages are stored in Supabase and delivered live while the site is open. Chats can be archived; messages can be edited for 15 minutes or deleted for everyone. If the live connection drops, an open conversation periodically refreshes.
- Create invite-only communities and topic groups from the **Groups** tab. Community owners can create groups and invite existing Mingle users by their registered mobile number or email; everyone invited to a community can use its groups. Group messages, photos, videos, and voice notes are available only to community members.
- Send photos (up to 10 MB), videos (up to 25 MB), and voice notes (up to 25 MB, recorded for at most 2 minutes) from the message bar. Voice recording requires microphone permission and a supported browser; the Android wrapper asks for microphone access when needed. Media is stored in a private Supabase Storage bucket. Free Supabase storage and bandwidth are limited; check your project quota before sharing large media.
- Open a one-to-one chat to use the video-camera and voice-call buttons in its header. Search filters messages in the open chat; the three-dot menu contains archive and device-only chat-lock actions. Calls use browser WebRTC and require HTTPS, microphone/camera permission, and the other person to be online and signed in. Networks that block direct peer-to-peer connections may also require the site owner to configure a TURN relay.
- Notifications and incoming-call alerts can arrive while a phone screen is locked or off if the phone is powered on, connected to the internet, permission is granted, and background push is configured. Android push needs Firebase setup; browser push also needs VAPID credentials. In **Settings → Notifications**, use **Send test notification** to check registered devices. Mingle requests server push for messages sent from web browsers as well as Android, so Android recipients do not depend on the sender having browser VAPID configured. A fully powered-off or force-stopped phone cannot receive calls or notifications, and an incoming call still needs to be accepted by the recipient.
- The Mingle Assistant answers a small set of Mingle help questions on-device. For other questions it can open a Google search containing only the text you typed; no chat history or account data is included. This is a search link, not an AI model or Google API integration.
- The optional PIN chat lock and its PIN verifier are stored only in this browser/device. This is a convenience screen lock, not server-side access control or message encryption; do not rely on it to protect data from someone with access to the account or browser storage.

Passwords are handled by Supabase Auth, not saved in website files. Messages are not end-to-end encrypted, and the Supabase project owner can access the database. Supabase Free has storage, usage, and inactivity limits; check its current limits before relying on it for important conversations.

Existing Supabase accounts and messages are kept by the schema migration. Accounts and messages stored only in the old self-hosted server are not migrated automatically.

## Owner account management

1. Create the owner account through Mingle's **Create account** tab using the intended owner email, the name `MChat Admin`, and the unique 10-digit mobile number `1000000000`. Enter the password directly in the sign-up form; never place it in source files, SQL migrations, or the APK. Confirm the email first if Supabase email confirmation is enabled.
2. In the Supabase SQL Editor, grant the server-controlled owner role to that existing account:

   ```sql
   update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"owner"}'::jsonb
   where lower(email) = lower('admin1@gmail.com')
   returning id, email;
   ```

   Check that exactly one row is returned, then sign out of Mingle and sign back in. The owner role is stored in Supabase `app_metadata`, which users cannot grant themselves from the browser.
3. The owner can open **Settings → Owner tools** to review accounts. Use **Reset password** to set a temporary password for an account that has no recovery email; share it privately and have the account owner change it after signing in. The existing password is never shown. This action is performed by a Supabase Edge Function, not by exposing an admin key in the website.
4. To enable owner password resets, deploy the function from the project folder after linking the Supabase project:

   ```powershell
   npx supabase login
   npx supabase link --project-ref zgbrpbbaherozfdfzxqh
   npx supabase functions deploy admin-reset-password
   ```

   Supabase keeps the service-role key in the function's server environment. Never add that key to website files or share it. The static website deployment does not deploy Edge Functions.
5. Deleting an account permanently removes that account, its direct chats/messages, community data it owns, and its related uploaded media. Deletion requires confirmation and typing the account email. The active owner and other owner accounts cannot be deleted.

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

The APK is written under `android-app\bin\Release\net10.0-android\publish`. The Mingle Android wrapper opens the configured GitHub Pages website automatically, supports picking photos/videos from the Android device, and requests microphone/camera access for calls and voice messages; previously installed versions keep their saved website address.
