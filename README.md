# Mingle Chat for Windows and Android

Mingle runs in a Windows browser and mobile browsers, and it can be installed from Chrome or Edge as an app. It has a self-hosted ASP.NET Core server; it does not use Firebase.

## What is included

- Real accounts saved on the app server; one account per 10-digit mobile number.
- Each account receives a different, automatically generated 8-digit account number.
- A password of 8 or more characters is salted and hashed on the server.
- Find another person by account number. Their name, phone number and account number appear in their profile.
- Messages are saved on the server and appear in open chats in real time. Unread messages are shown in the chat list.
- Optional Windows and mobile background notifications, when the user presses **Enable notifications on this device** and allows browser notifications.

Phone number ownership is not verified by SMS. Never share your password. Notifications need HTTPS and browser permission.

## Run on your Windows computer

Install the free .NET 10 SDK, open PowerShell in this `chat-app` folder and run:

```powershell
$env:ASPNETCORE_URLS = "http://localhost:5080"
dotnet run --project .\server\server.csproj
```

Open `http://localhost:5080` in Edge or Chrome. Accounts and messages are stored under `server\App_Data`. Keep the server running while you use the app.

## Use on Android and with other people

Real messages between different people require everyone to open the **same publicly hosted HTTPS site** and its server must stay online. Running this project only on your Windows computer makes it available on that computer alone; it does not automatically publish it to the internet. Deploy the `server` project to an ASP.NET Core host such as Azure App Service. Enable **persistent storage** for `server\App_Data` and set `MINGLE_DATA_PATH` to the host's permanent writable data folder; without persistent storage, accounts and messages could be lost when a host restarts.

On your Android phone, open the host's HTTPS address in Chrome and select **Install app** or **Add to Home screen**. People on Windows can use Edge/Chrome. Ask each person to create an account, then share their 8-digit account number so the other person can find their profile and message them.

Grant notifications on each device from **Profile → Enable notifications on this device**. Push notifications may be delayed or disabled by browser, power-saving and operating-system settings. Mingle also keeps messages unread in the chat list and displays new messages while the site is open.

## Build the Android APK

The Android app is a free installable wrapper for the hosted Mingle site; it does not bundle or replace the chat server. Install the .NET 10 Android workload and Android SDK, then run these commands from the `chat-app` folder:

```powershell
dotnet workload install android
dotnet publish .\android-app\Mingle.Android.csproj -c Release -f net10.0-android -p:AndroidPackageFormat=apk
```

The APK is written under `android-app\bin\Release\net10.0-android\publish`. On first launch, enter the public HTTPS address of the deployed Mingle server. Until a server is deployed, the APK can be installed but accounts and messaging will not work. The app accepts HTTPS addresses only.

For a Windows standalone server publish:

```powershell
dotnet publish .\server\server.csproj -c Release -r win-x64 --self-contained true
```

The published Windows server can also be hosted on a Windows computer with an internet connection and public HTTPS. Keep the computer and server online, configure a domain/HTTPS and persistent storage, and do not expose the app over unencrypted public HTTP.

This is a web app, not a Google Play APK. Messages are not end-to-end encrypted; the server operator can access stored messages.
