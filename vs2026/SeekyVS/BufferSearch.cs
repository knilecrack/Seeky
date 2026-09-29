// SeekyVS — Visual Studio 2026 port spike for the Seeky VS Code extension.

namespace SeekyVS;

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

/// <summary>
/// Line search over one document's text for the "Current File" picker mode — the in-process
/// counterpart of fff's grep, which only sees what is saved on disk and searches the whole
/// workspace. Honors the same plain / regex / fuzzy / any sub-modes as Live Grep.
/// </summary>
internal static class BufferSearch
{
    /// <summary>A matching line: 1-based line/col, the line with its indentation stripped, and
    /// [start, end) char ranges into that text.</summary>
    internal readonly record struct Hit(int Line, int Col, string Text, SeekyRange[] Ranges);

    /// <summary>
    /// Matches <paramref name="query"/> against every line. Plain and regex are smart-case (a
    /// capital in the query makes it case-sensitive) and return hits in line order; fuzzy
    /// returns them best-first. "any" matches any of the <c>|</c>-separated literal patterns
    /// (file constraints mean nothing within one file, so none are parsed). An invalid regex falls back to a literal search and reports why
    /// in <paramref name="regexError"/>, like fff does for Live Grep.
    /// </summary>
    internal static List<Hit> Search(
        IReadOnlyList<string> lines, string query, string grepMode, int maxResults, out string? regexError)
    {
        regexError = null;
        if (grepMode == "fuzzy")
        {
            return Fuzzy(lines, query, maxResults);
        }

        RegexOptions options = query.Any(char.IsUpper) ? RegexOptions.None : RegexOptions.IgnoreCase;
        string source = grepMode switch
        {
            "regex" => query,
            "any" => string.Join('|', query
                .Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(Regex.Escape)),
            _ => Regex.Escape(query),
        };
        if (source.Length == 0)
        {
            return [];
        }

        Regex pattern;
        try
        {
            pattern = new Regex(source, options, TimeSpan.FromMilliseconds(200));
        }
        catch (ArgumentException ex)
        {
            regexError = ex.Message;
            pattern = new Regex(Regex.Escape(query), options);
        }

        var hits = new List<Hit>();
        for (int i = 0; i < lines.Count && hits.Count < maxResults; i++)
        {
            (string text, int indent) = Trim(lines[i]);
            SeekyRange[] ranges;
            try
            {
                ranges = pattern.Matches(text)
                    .Where(m => m.Length > 0)
                    .Select(m => new SeekyRange(m.Index, m.Index + m.Length))
                    .ToArray();
            }
            catch (RegexMatchTimeoutException)
            {
                continue; // a pathological pattern on one line should not sink the whole search
            }

            if (ranges.Length > 0)
            {
                hits.Add(new Hit(i + 1, indent + ranges[0].Start + 1, text, ranges));
            }
        }

        return hits;
    }

    private static List<Hit> Fuzzy(IReadOnlyList<string> lines, string query, int maxResults)
    {
        var scored = new List<(Hit Hit, int Score)>();
        for (int i = 0; i < lines.Count; i++)
        {
            (string text, int indent) = Trim(lines[i]);
            if (FuzzyMatcher.TryMatch(query, text, out int score, out (int Start, int End)[] ranges)
                && ranges.Length > 0)
            {
                SeekyRange[] spans = ranges.Select(r => new SeekyRange(r.Start, r.End)).ToArray();
                scored.Add((new Hit(i + 1, indent + spans[0].Start + 1, text, spans), score));
            }
        }

        scored.Sort(static (a, b) =>
        {
            int byScore = b.Score.CompareTo(a.Score);
            return byScore != 0 ? byScore : a.Hit.Line.CompareTo(b.Hit.Line);
        });

        return scored.Take(maxResults).Select(s => s.Hit).ToList();
    }

    // Rows are narrow; leading indentation would push every match off to the right.
    private static (string Text, int Indent) Trim(string line)
    {
        string text = line.TrimStart();
        return (text.TrimEnd('\r', '\n'), line.Length - text.Length);
    }
}
