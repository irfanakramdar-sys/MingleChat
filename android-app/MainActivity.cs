using Android.App;
using Android.Content;
using Android.Content.PM;
using Android.Graphics;
using Android.OS;
using Android.Text;
using Android.Views;
using Android.Views.InputMethods;
using Android.Webkit;
using Android.Widget;

namespace Mingle.Android;

[Activity(
    Label = "Mingle Chat",
    MainLauncher = true,
    Exported = true,
    Theme = "@android:style/Theme.Material.Light.NoActionBar",
    ConfigurationChanges = ConfigChanges.Orientation | ConfigChanges.ScreenSize | ConfigChanges.KeyboardHidden)]
public sealed class MainActivity : Activity
{
    private const string ServerPreference = "server_url";
    private const string DefaultServerUrl = "https://irfanakramdar-sys.github.io/MingleChat/";
    private const int MediaPickerRequestCode = 4107;
    private static readonly Color Ink = Color.Rgb(32, 46, 39);
    private static readonly Color Muted = Color.Rgb(104, 119, 110);
    private static readonly Color Green = Color.Rgb(22, 119, 88);
    private LinearLayout? _root;
    private EditText? _serverInput;
    private WebView? _webView;
    private IValueCallback? _mediaPickerCallback;

    protected override void OnCreate(Bundle? savedInstanceState)
    {
        base.OnCreate(savedInstanceState);
        Window?.SetStatusBarColor(Color.Rgb(247, 248, 246));
        Window?.SetNavigationBarColor(Color.Rgb(247, 248, 246));
        Window?.SetSoftInputMode(SoftInput.AdjustResize);

        var savedServer = GetPreferences(FileCreationMode.Private)?.GetString(ServerPreference, null);
        OpenServer(string.IsNullOrWhiteSpace(savedServer) ? DefaultServerUrl : savedServer);
    }

    protected override void OnDestroy()
    {
        _mediaPickerCallback?.OnReceiveValue(null);
        _mediaPickerCallback = null;
        _webView?.Destroy();
        _webView = null;
        base.OnDestroy();
    }

    protected override void OnActivityResult(int requestCode, Result resultCode, Intent? data)
    {
        base.OnActivityResult(requestCode, resultCode, data);
        if (requestCode != MediaPickerRequestCode)
        {
            return;
        }

        var callback = _mediaPickerCallback;
        _mediaPickerCallback = null;
        callback?.OnReceiveValue(resultCode == Result.Ok
            ? WebChromeClient.FileChooserParams.ParseResult((int)resultCode, data)
            : null);
    }

    private void ShowServerSetup(string? currentServer)
    {
        _webView?.Destroy();
        _webView = null;
        _root = new LinearLayout(this)
        {
            Orientation = Orientation.Vertical
        };
        _root.SetBackgroundColor(Color.Rgb(247, 248, 246));
        _root.SetPadding(Dp(24), Dp(36), Dp(24), Dp(24));

        var title = new TextView(this)
        {
            Text = "Mingle Chat",
            TextSize = 28,
            Typeface = Typeface.Create("sans-serif-medium", TypefaceStyle.Normal)
        };
        title.SetTextColor(Ink);
        _root.AddView(title, MatchWrap());

        var description = new TextView(this)
        {
            Text = "Open your hosted Mingle website to start chatting.",
            TextSize = 16
        };
        description.SetTextColor(Muted);
        description.SetPadding(0, Dp(8), 0, Dp(24));
        _root.AddView(description, MatchWrap());

        var label = new TextView(this)
        {
            Text = "Mingle website HTTPS address",
            TextSize = 14,
            Typeface = Typeface.Create("sans-serif-medium", TypefaceStyle.Normal)
        };
        label.SetTextColor(Ink);
        _root.AddView(label, MatchWrap());

        _serverInput = new EditText(this)
        {
            Hint = "https://your-name.github.io/MingleChat/",
            InputType = InputTypes.ClassText | InputTypes.TextVariationUri,
            ImeOptions = ImeAction.Go,
            Text = currentServer ?? string.Empty
        };
        _serverInput.SetSingleLine(true);
        _serverInput.SetSelectAllOnFocus(true);
        _root.AddView(_serverInput, MatchWrap());

        var connectButton = new Button(this)
        {
            Text = "Connect to Mingle"
        };
        connectButton.SetTextColor(Color.White);
        connectButton.SetBackgroundColor(Green);
        connectButton.Click += (_, _) => ConnectToEnteredServer();
        _root.AddView(connectButton, MatchWrap());

        var note = new TextView(this)
        {
            Text = "Enter the public HTTPS address of your Mingle website. Accounts and messages use its online database.",
            TextSize = 13
        };
        note.SetTextColor(Muted);
        note.SetPadding(0, Dp(20), 0, 0);
        _root.AddView(note, MatchWrap());

        SetContentView(_root);
    }

    private void ConnectToEnteredServer()
    {
        var value = _serverInput?.Text?.Trim().TrimEnd('/');
        if (!Uri.TryCreate(value, UriKind.Absolute, out var server)
            || server.Scheme != Uri.UriSchemeHttps
            || string.IsNullOrWhiteSpace(server.Host)
            || !string.IsNullOrEmpty(server.UserInfo))
        {
            _serverInput?.SetError("Enter a valid public HTTPS address.", null);
            return;
        }

        var preferences = GetPreferences(FileCreationMode.Private);
        preferences?.Edit()?.PutString(ServerPreference, server.GetLeftPart(UriPartial.Authority) + server.AbsolutePath.TrimEnd('/'))?.Apply();
        OpenServer(server.GetLeftPart(UriPartial.Authority) + server.PathAndQuery.TrimEnd('/'));
    }

    private void OpenServer(string serverUrl)
    {
        _root = new LinearLayout(this)
        {
            Orientation = Orientation.Vertical
        };

        var toolbar = new LinearLayout(this)
        {
            Orientation = Orientation.Horizontal
        };
        toolbar.SetGravity(GravityFlags.CenterVertical);
        toolbar.SetBackgroundColor(Color.Rgb(247, 248, 246));
        toolbar.SetPadding(Dp(16), Dp(4), Dp(8), Dp(4));

        var title = new TextView(this)
        {
            Text = "Mingle",
            TextSize = 18,
            Typeface = Typeface.Create("sans-serif-medium", TypefaceStyle.Normal)
        };
        title.SetTextColor(Ink);
        toolbar.AddView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WrapContent, 1));

        var changeServer = new Button(this)
        {
            Text = "Website"
        };
        changeServer.Click += (_, _) => ShowServerSetup(serverUrl);
        toolbar.AddView(changeServer, WrapWrap());
        _root.AddView(toolbar, MatchWrap());

        _webView = new WebView(this);
        _webView.Settings.JavaScriptEnabled = true;
        _webView.Settings.DomStorageEnabled = true;
        _webView.Settings.AllowFileAccess = false;
        _webView.Settings.AllowContentAccess = false;
        _webView.Settings.JavaScriptCanOpenWindowsAutomatically = false;
        _webView.Settings.MixedContentMode = MixedContentHandling.NeverAllow;
        _webView.SetWebViewClient(new MingleWebViewClient(new Uri(serverUrl).Authority));
        _webView.SetWebChromeClient(new MingleWebChromeClient(this));
        _root.AddView(_webView, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MatchParent,
            0,
            1));

        SetContentView(_root);
        _webView.LoadUrl(serverUrl);
    }

    private int Dp(int value) => (int)(value * Resources!.DisplayMetrics!.Density + 0.5f);

    private static LinearLayout.LayoutParams MatchWrap() =>
        new(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.WrapContent);

    private static LinearLayout.LayoutParams WrapWrap() =>
        new(ViewGroup.LayoutParams.WrapContent, ViewGroup.LayoutParams.WrapContent);

    private sealed class MingleWebViewClient(string serverAuthority) : WebViewClient
    {
        public override bool ShouldOverrideUrlLoading(WebView? view, IWebResourceRequest? request)
        {
            var destination = request?.Url;
            return destination?.Scheme != Uri.UriSchemeHttps
                || !string.Equals(destination.Authority, serverAuthority, StringComparison.OrdinalIgnoreCase);
        }
    }

    private sealed class MingleWebChromeClient(MainActivity activity) : WebChromeClient
    {
        public override bool OnShowFileChooser(
            WebView? webView,
            IValueCallback? filePathCallback,
            FileChooserParams? fileChooserParams)
        {
            activity._mediaPickerCallback?.OnReceiveValue(null);
            activity._mediaPickerCallback = filePathCallback;
            if (fileChooserParams is null || filePathCallback is null)
            {
                activity._mediaPickerCallback = null;
                return false;
            }

            try
            {
                activity.StartActivityForResult(fileChooserParams.CreateIntent(), MediaPickerRequestCode);
                return true;
            }
            catch (ActivityNotFoundException)
            {
                activity._mediaPickerCallback = null;
                filePathCallback.OnReceiveValue(null);
                return false;
            }
        }
    }
}
