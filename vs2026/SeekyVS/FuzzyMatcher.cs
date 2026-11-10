// SeekyVS — Visual Studio 2026 port spike for the Seeky VS Code extension.

namespace SeekyVS;

using System;
using System.Collections.Generic;

/// <summary>
/// Subsequence fuzzy matcher over short identifiers, scoring camel-hump and word-boundary hits
/// the way "shwcr" is expected to find "ShowCoreAsync".
/// </summary>
/// <remarks>
/// fff does the fuzzy matching for file and grep searches natively; symbol search cannot reuse it
/// because the candidates are names this process extracted from grep lines
/// (<see cref="SymbolClassifier"/>), not paths fff has indexed. Greedy left-to-right with a
/// boundary-preferring first hit — good enough for identifier-length strings. <see cref="TryScore"/>
/// is allocation-free and is what ranking uses; <see cref="TryMatch"/> additionally collects the
/// spans for the rows that end up drawn.
/// </remarks>
internal static class FuzzyMatcher
{
    private const int BoundaryBonus = 12;
    private const int ConsecutiveBonus = 8;
    private const int FirstCharBonus = 10;
    private const int GapPenalty = 1;
    private const int MaxGapPenalty = 12;

    /// <summary>
    /// Scores <paramref name="query"/> against <paramref name="candidate"/>. Returns false only
    /// when the query is not a case-insensitive subsequence of the candidate. An empty query
    /// matches with score 0 and no ranges. Higher scores are better.
    /// </summary>
    internal static bool TryMatch(string query, string candidate, out int score, out (int Start, int End)[] ranges)
    {
        score = 0;
        ranges = [];
        if (query.Length == 0)
        {
            return true;
        }

        if (candidate.Length == 0 || query.Length > candidate.Length)
        {
            return false;
        }

        var spans = new List<(int Start, int End)>(query.Length);

        // Preferring word boundaries gives better ranges but is greedy, so it can step over a
        // subsequence that does exist: "targetresult" vs "TargetResult" jumps from 'Ta|r' to the
        // camel-hump 'R', skipping "rget", and then finds no 'g'. Plain left-to-right is complete
        // for subsequence detection, so a failed boundary pass retries without it — the score
        // suffers, but a real match is never reported as a miss.
        if (!TryMatchCore(query, candidate, preferBoundaries: true, spans, out score))
        {
            spans.Clear();
            if (!TryMatchCore(query, candidate, preferBoundaries: false, spans, out score))
            {
                return false;
            }
        }

        ranges = [.. spans];
        return true;
    }

    /// <summary>
    /// Scores without building the match spans. This is what ranking uses — a symbol query runs
    /// it over every candidate, and the ranges are only ever drawn for the handful of rows that
    /// survive the cut. Same score, no per-candidate allocation.
    /// </summary>
    internal static bool TryScore(string query, string candidate, out int score)
    {
        score = 0;
        if (query.Length == 0)
        {
            return true;
        }

        if (candidate.Length == 0 || query.Length > candidate.Length)
        {
            return false;
        }

        return TryMatchCore(query, candidate, preferBoundaries: true, spans: null, out score)
            || TryMatchCore(query, candidate, preferBoundaries: false, spans: null, out score);
    }

    /// <param name="spans">
    /// Collects the matched spans when the caller needs ranges; null when it only wants the score.
    /// Passing null is what keeps <see cref="TryScore"/> allocation-free.
    /// </param>
    private static bool TryMatchCore(
        string query, string candidate, bool preferBoundaries, List<(int Start, int End)>? spans, out int score)
    {
        score = 0;

        int candidateIndex = 0;
        int previousMatch = -2;
        int total = 0;

        for (int q = 0; q < query.Length; q++)
        {
            char wanted = char.ToLowerInvariant(query[q]);
            int found = -1;
            int fallback = -1;

            // Prefer a hit on a word boundary (start, camel hump, after _ . / -) over the first
            // available one: "sm" should land on "SeekyModal", not on the "s"+"m" inside "Seeky".
            // A hit that continues the previous one always wins — that is what keeps runs intact.
            bool consecutive = candidateIndex == previousMatch + 1
                && candidateIndex < candidate.Length
                && char.ToLowerInvariant(candidate[candidateIndex]) == wanted;
            if (preferBoundaries && !consecutive)
            {
                for (int c = candidateIndex; c < candidate.Length; c++)
                {
                    if (char.ToLowerInvariant(candidate[c]) != wanted)
                    {
                        continue;
                    }

                    if (fallback < 0)
                    {
                        fallback = c;
                    }

                    if (IsBoundary(candidate, c))
                    {
                        found = c;
                        break;
                    }
                }
            }

            if (found < 0 && fallback < 0)
            {
                for (int c = candidateIndex; c < candidate.Length; c++)
                {
                    if (char.ToLowerInvariant(candidate[c]) == wanted)
                    {
                        fallback = c;
                        break;
                    }
                }
            }

            if (found < 0)
            {
                found = fallback;
            }

            if (found < 0)
            {
                return false;
            }

            int gain = 1;
            if (found == 0)
            {
                gain += FirstCharBonus;
            }

            if (IsBoundary(candidate, found))
            {
                gain += BoundaryBonus;
            }

            if (found == previousMatch + 1)
            {
                gain += ConsecutiveBonus;
                if (spans is not null)
                {
                    var last = spans[spans.Count - 1];
                    spans[spans.Count - 1] = (last.Start, found + 1);
                }
            }
            else
            {
                int gap = previousMatch < 0 ? found : found - previousMatch - 1;
                gain -= Math.Min(gap * GapPenalty, MaxGapPenalty);
                spans?.Add((found, found + 1));
            }

            total += gain;
            previousMatch = found;
            candidateIndex = found + 1;
        }

        // Prefer tight matches over long names that merely contain the letters.
        total -= candidate.Length / 4;
        if (candidate.Length == query.Length)
        {
            total += 20;
        }

        score = total;
        return true;
    }

    private static bool IsBoundary(string text, int index)
    {
        if (index == 0)
        {
            return true;
        }

        char current = text[index];
        char previous = text[index - 1];
        if (previous is '_' or '.' or '/' or '\\' or '-' or ' ')
        {
            return true;
        }

        return char.IsUpper(current) && !char.IsUpper(previous);
    }
}
