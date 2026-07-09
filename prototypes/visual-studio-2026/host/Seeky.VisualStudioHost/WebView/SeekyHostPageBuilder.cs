using System.Text.Json;

namespace Seeky.VisualStudioHost.WebView;

public static class SeekyHostPageBuilder
{
    public static string Build(string mediaRoot, string initialMode = "grep", string initialQuery = "")
    {
        var normalizedMediaRoot = mediaRoot.TrimEnd('/');
        var modeLiteral = JsonSerializer.Serialize(initialMode);
        var queryLiteral = JsonSerializer.Serialize(initialQuery);
        var mediaLiteral = JsonSerializer.Serialize(normalizedMediaRoot);

        return $$"""
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Seeky</title>
    <link rel="stylesheet" href="{{normalizedMediaRoot}}/codicon.css">
    <link rel="stylesheet" href="{{normalizedMediaRoot}}/style.css">
</head>
<body>
    <script>
        window.INITIAL_MODE = {{modeLiteral}};
        window.INITIAL_QUERY = {{queryLiteral}};
        window.MEDIA_URI = {{mediaLiteral}};
        window.acquireVsCodeApi ??= function () {
            return {
                postMessage: function (message) {
                    window.chrome.webview.postMessage(message);
                },
                getState: function () {
                    return null;
                },
                setState: function (_state) {
                }
            };
        };
    </script>
    <script src="{{normalizedMediaRoot}}/icon-map.js"></script>
    <script src="{{normalizedMediaRoot}}/main.js"></script>
</body>
</html>
""";
    }
}
