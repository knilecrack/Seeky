// SeekyVS - Visual Studio 2026 port spike for the Seeky VS Code extension.

namespace SeekyVS;

using System;
using System.Collections.Generic;

/// <summary>
/// The ranking half of <see cref="SymbolIndex"/>: given the swept symbol list and a query, pick
/// the best rows. A partial class in its own file so it compiles without the native client — this
/// is pure CPU work, and it is the part every keystroke pays for.
/// </summary>
internal static partial class SymbolIndex
{
    /// <summary>A declared symbol: where it is, what it is, and the source line it came from.</summary>
    internal readonly record struct Entry(
        string Path, int Line, int Col, string Text, string Kind, string Name, string? GitStatus, bool IsBinary);

    /// <summary>A symbol that matched a query, with the match spans into <see cref="Entry.Name"/>.</summary>
    internal readonly record struct Hit(Entry Entry, int Score, SeekyRange[] NameRanges);

    /// <summary>
    /// Ranks <paramref name="entries"/> against <paramref name="query"/> by fuzzy name match. An
    /// empty query lists the workspace's symbols in index order.
    /// </summary>
    internal static List<Hit> Query(IReadOnlyList<Entry> entries, string query, int maxResults)
    {
        var hits = new List<Hit>(Math.Min(Math.Max(maxResults, 0), entries.Count));
        if (maxResults <= 0)
        {
            return hits;
        }

        if (query.Length == 0)
        {
            for (int i = 0; i < entries.Count && hits.Count < maxResults; i++)
            {
                hits.Add(new Hit(entries[i], 0, []));
            }

            return hits;
        }

        // Bounded top-N selection instead of "score every match, build its ranges, then sort the
        // lot": a one-character query matches tens of thousands of symbols, and only the
        // maxResults rows that survive are ever drawn. The heap keeps the worst kept match at the
        // root, so a candidate replaces it only when it ranks better — O(matches × log maxResults)
        // comparisons and no per-match allocation. Spans are collected afterwards, for the
        // surviving rows only.
        var best = new List<Ranked>(Math.Min(maxResults, entries.Count) + 1);
        foreach (Entry entry in entries)
        {
            if (!FuzzyMatcher.TryScore(query, entry.Name, out int score))
            {
                continue;
            }

            var ranked = new Ranked(entry, score, KindRank(entry.Kind));
            if (best.Count < maxResults)
            {
                best.Add(ranked);
                SiftUp(best, best.Count - 1);
            }
            else if (Compare(ranked, best[0]) < 0)
            {
                best[0] = ranked;
                SiftDown(best, 0);
            }
        }

        best.Sort(Compare);
        foreach (Ranked ranked in best)
        {
            hits.Add(new Hit(ranked.Entry, ranked.Score, RangesFor(query, ranked.Entry.Name)));
        }

        return hits;
    }

    /// <summary>A match held by the top-N heap: the entry, its score, and its precomputed kind rank.</summary>
    private readonly record struct Ranked(Entry Entry, int Score, int Kind);

    /// <summary>Orders two matches best first — the order the result list wants.</summary>
    private static int Compare(Ranked a, Ranked b)
    {
        int byScore = b.Score.CompareTo(a.Score);
        if (byScore != 0)
        {
            return byScore;
        }

        // Equal-scoring names are usually the same identifier declared in several places —
        // the type declaration is nearly always the one being looked for.
        int byKind = a.Kind.CompareTo(b.Kind);
        if (byKind != 0)
        {
            return byKind;
        }

        int byLength = a.Entry.Name.Length.CompareTo(b.Entry.Name.Length);
        if (byLength != 0)
        {
            return byLength;
        }

        int byPath = string.CompareOrdinal(a.Entry.Path, b.Entry.Path);
        return byPath != 0 ? byPath : a.Entry.Line.CompareTo(b.Entry.Line);
    }

    // Both heap helpers work under Compare's ordering: the root is the worst kept match.

    private static void SiftUp(List<Ranked> heap, int index)
    {
        while (index > 0)
        {
            int parent = (index - 1) / 2;
            if (Compare(heap[index], heap[parent]) <= 0)
            {
                return;
            }

            (heap[index], heap[parent]) = (heap[parent], heap[index]);
            index = parent;
        }
    }

    private static void SiftDown(List<Ranked> heap, int index)
    {
        while (true)
        {
            int left = (2 * index) + 1;
            if (left >= heap.Count)
            {
                return;
            }

            int worse = left;
            int right = left + 1;
            if (right < heap.Count && Compare(heap[right], heap[left]) > 0)
            {
                worse = right;
            }

            if (Compare(heap[worse], heap[index]) <= 0)
            {
                return;
            }

            (heap[index], heap[worse]) = (heap[worse], heap[index]);
            index = worse;
        }
    }

    /// <summary>
    /// The match spans for a row that survived ranking. Only called for the returned rows: the
    /// ranking pass itself never builds ranges.
    /// </summary>
    private static SeekyRange[] RangesFor(string query, string name)
    {
        if (!FuzzyMatcher.TryMatch(query, name, out _, out (int Start, int End)[] ranges))
        {
            return [];
        }

        var named = new SeekyRange[ranges.Length];
        for (int i = 0; i < ranges.Length; i++)
        {
            named[i] = new SeekyRange(ranges[i].Start, ranges[i].End);
        }

        return named;
    }

    /// <summary>
    /// Tie-break order for equally-scoring symbols: types, then members, then fields, then the
    /// per-file <c>namespace</c> lines (numerous and rarely what a symbol search is after).
    /// </summary>
    private static int KindRank(string kind) => kind switch
    {
        "class" or "interface" or "struct" or "record" or "enum" or "delegate" or "impl" or "type" => 0,
        "method" or "property" => 1,
        "namespace" => 3,
        _ => 2,
    };
}