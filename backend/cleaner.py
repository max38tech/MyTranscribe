"""
Speech Disfluency and Filler Word Cleanup Engine for MyTranscribe.
Handles elongated vocal fillers (e.g. 'uuhmmm', 'ummm', 'errr'),
stutters, repeated words, verbal crutches, and automatic punctuation repair.
"""

from __future__ import annotations
import re
from typing import List, Dict, Any, Optional, Set


class DisfluencyCleaner:
    """
    Intelligently cleans speech disfluencies, filler words, repetitions,
    and formats punctuation and capitalization.
    """

    # Core vocal sounds and elongated patterns (e.g., uuhmmm, ahhh, errr)
    ELONGATED_PATTERNS = [
        r"\bu+h+m*\b",          # uh, uhm, uuh, uuhm, uuhmmm
        r"\bu+m+\b",            # um, umm, ummm
        r"\be+r+\b",            # er, err, errr
        r"\ba+h+\b",            # ah, ahh, ahhh
        r"\bh+m+\b",            # hm, hmm, hmmm
        r"\be+h+\b",            # eh, ehh
        r"\bm+h+m+\b",          # mhm, mhmm
        r"\bu+h+[- ]h+u+h+\b",  # uh-huh, uh huh
    ]

    DEFAULT_VOCAL_FILLERS = {
        "uh", "um", "er", "ah", "eh", "hmm", "hm", "mhm", "uh-huh",
        "uuh", "umm", "uuhm", "uuhmmm", "ummm", "err", "errr", "ahh", "ahhh",
    }

    DEFAULT_VERBAL_CRUTCHES = {
        "you know", "i mean", "like", "sort of", "kind of",
        "basically", "actually", "literally", "honestly",
    }

    def __init__(
        self,
        remove_vocal_fillers: bool = True,
        remove_verbal_crutches: bool = False,
        remove_repetitions: bool = True,
        remove_stutters: bool = True,
        custom_fillers: Optional[List[str]] = None,
        custom_preserve: Optional[List[str]] = None,
    ):
        self.remove_vocal_fillers = remove_vocal_fillers
        self.remove_verbal_crutches = remove_verbal_crutches
        self.remove_repetitions = remove_repetitions
        self.remove_stutters = remove_stutters
        self.custom_fillers = set(w.lower().strip() for w in (custom_fillers or []))
        self.custom_preserve = set(w.lower().strip() for w in (custom_preserve or []))

    def clean(self, text: str) -> Dict[str, Any]:
        """
        Clean text and return cleaned string, metrics, and diff representation.
        """
        if not text or not text.strip():
            return {
                "cleaned_text": "",
                "raw_text": text,
                "removed_count": 0,
                "removed_items": [],
                "diff_html": "",
            }

        raw_text = text
        removed_items: List[Dict[str, Any]] = []

        # Step 1: Hyphenated stutter cleanup (e.g., "w- we", "th- that", "I- I")
        if self.remove_stutters:
            text, stutter_removals = self._clean_hyphen_stutters(text)
            removed_items.extend(stutter_removals)

        # Step 2: Multi-word verbal crutches if enabled (e.g., "you know", "i mean")
        if self.remove_verbal_crutches:
            text, crutch_removals = self._clean_phrases(text, self.DEFAULT_VERBAL_CRUTCHES)
            removed_items.extend(crutch_removals)

        # Step 3: Custom filler phrases
        if self.custom_fillers:
            custom_phrases = {f for f in self.custom_fillers if " " in f}
            if custom_phrases:
                text, custom_phrase_removals = self._clean_phrases(text, custom_phrases)
                removed_items.extend(custom_phrase_removals)

        # Step 4: Token-level vocal disfluencies, single-word verbal crutches, custom words
        text, token_removals = self._clean_tokens(text)
        removed_items.extend(token_removals)

        # Step 5: Word repetitions (e.g., "I I think", "the the dog")
        if self.remove_repetitions:
            text, rep_removals = self._clean_repetitions(text)
            removed_items.extend(rep_removals)

        # Step 6: Punctuation and Capitalization repair
        cleaned_text = self._repair_formatting(text)

        # Step 7: Build diff HTML for UI visualization
        diff_html = self._generate_diff_html(raw_text, cleaned_text, removed_items)

        return {
            "cleaned_text": cleaned_text,
            "raw_text": raw_text,
            "removed_count": len(removed_items),
            "removed_items": removed_items,
            "diff_html": diff_html,
        }

    def _clean_hyphen_stutters(self, text: str) -> tuple[str, List[Dict[str, Any]]]:
        """Removes hyphenated false-starts like 'th- that' or 'I- I'."""
        removals = []

        def replacer(match):
            prefix = match.group(1)
            removals.append({"word": prefix + "-", "category": "stutter"})
            return match.group(2)

        pattern = re.compile(r"\b([a-zA-Z]{1,3})-(?:\s+)?([a-zA-Z]+)\b", re.IGNORECASE)
        # Check if the prefix matches the beginning of the following word
        def match_filter(match):
            prefix = match.group(1).lower()
            word = match.group(2).lower()
            if word.startswith(prefix) or prefix in ("i", "a"):
                removals.append({"word": match.group(1) + "-", "category": "stutter"})
                return match.group(2)
            return match.group(0)

        cleaned = pattern.sub(match_filter, text)
        return cleaned, removals

    def _clean_phrases(self, text: str, phrases: Set[str]) -> tuple[str, List[Dict[str, Any]]]:
        """Removes multi-word filler phrases."""
        removals = []
        for phrase in sorted(phrases, key=len, reverse=True):
            if phrase.lower() in self.custom_preserve:
                continue
            pattern = re.compile(r"(?:\b|,\s*)" + re.escape(phrase) + r"(?:\b|,\s*)", re.IGNORECASE)
            def replacer(match):
                removals.append({"word": match.group(0).strip(" ,"), "category": "phrase"})
                return " "
            text = pattern.sub(replacer, text)
        return text, removals

    def _is_vocal_filler(self, word: str) -> bool:
        """Checks if a word is an elongated filler sound or vocal disfluency."""
        word_clean = word.lower()
        if word_clean in self.custom_preserve:
            return False
        if word_clean in self.DEFAULT_VOCAL_FILLERS:
            return True
        for pattern in self.ELONGATED_PATTERNS:
            if re.fullmatch(pattern, word_clean, re.IGNORECASE):
                return True
        return False

    def _clean_tokens(self, text: str) -> tuple[str, List[Dict[str, Any]]]:
        """Strips vocal disfluencies, filler words, and their surrounding conversational commas."""
        removals = []

        # Step A: Remove vocal disfluencies with surrounding commas (e.g., ', uh,', ', ummm,', ', uhh')
        if self.remove_vocal_fillers:
            # Pattern matching elongated filler sounds with optional surrounding commas
            vocal_regex_parts = [
                r"u+h+m*", r"u+m+", r"e+r+", r"a+h+", r"h+m+", r"e+h+", r"m+h+m+",
                r"u+h+[- ]h+u+h+", r"uh", r"um", r"er", r"ah", r"eh", r"hmm", r"hm", r"mhm"
            ]
            vocal_pattern = re.compile(
                r"(?:,\s*)?\b(" + "|".join(vocal_regex_parts) + r")\b(?:,\s*)?",
                re.IGNORECASE
            )

            def vocal_sub(match):
                word = match.group(1)
                if word.lower() in self.custom_preserve:
                    return match.group(0)
                removals.append({"word": word, "category": "vocal_filler"})
                return " "

            text = vocal_pattern.sub(vocal_sub, text)

        # Step B: Custom filler words & Single-word verbal crutches
        tokens = re.split(r"(\s+)", text)
        result_tokens = []

        for token in tokens:
            if not token or token.isspace():
                result_tokens.append(token)
                continue

            stripped_match = re.match(r"^([^\w]*)([\w'-]+)([^\w]*)$", token, re.UNICODE)
            if not stripped_match:
                result_tokens.append(token)
                continue

            prefix, core_word, suffix = stripped_match.groups()
            core_lower = core_word.lower()

            should_remove = False
            category = "filler"

            if core_lower in self.custom_preserve:
                should_remove = False
            elif core_lower in self.custom_fillers:
                should_remove = True
                category = "custom_filler"
            elif self.remove_verbal_crutches and core_lower in self.DEFAULT_VERBAL_CRUTCHES:
                should_remove = True
                category = "verbal_crutch"

            if should_remove:
                removals.append({"word": core_word, "category": category})
                trailing_sentence_punct = "".join(c for c in suffix if c in ".?!")
                if trailing_sentence_punct:
                    result_tokens.append(trailing_sentence_punct)
            else:
                result_tokens.append(token)

        return "".join(result_tokens), removals

    def _clean_repetitions(self, text: str) -> tuple[str, List[Dict[str, Any]]]:
        """Removes consecutive repeated words (e.g. 'I I think' -> 'I think')."""
        removals = []

        # Matches consecutive repeated words ignoring punctuation between them
        def rep_replacer(match):
            w1 = match.group(1)
            w2 = match.group(2)
            if w1.lower() == w2.lower() and w1.lower() not in self.custom_preserve:
                # Keep some natural English doublings like 'that that', 'had had' if appropriate,
                # but standard spoken repetitions like 'I I', 'the the' are stripped.
                if w1.lower() not in {"that", "had"}:
                    removals.append({"word": w1, "category": "repetition"})
                    return w2
            return match.group(0)

        pattern = re.compile(r"\b([a-zA-Z]+)\b(?:\s*,\s*|\s+)\b([a-zA-Z]+)\b", re.IGNORECASE)
        # Apply twice for triplets like 'I I I'
        cleaned = pattern.sub(rep_replacer, text)
        cleaned = pattern.sub(rep_replacer, cleaned)
        return cleaned, removals

    def _repair_formatting(self, text: str) -> str:
        """Fixes spacing, hanging commas, and sentence capitalization."""
        if not text:
            return ""

        # Remove hanging or duplicate commas: e.g. ", ,", ",.", " ,"
        text = re.sub(r",\s*,+", ",", text)
        text = re.sub(r",\s*\.", ".", text)
        text = re.sub(r"\.\s*,", ".", text)
        text = re.sub(r"\s+([,.:;?!])", r"\1", text)
        text = re.sub(r"^[,\s;:-]+", "", text)  # leading punctuation
        text = re.sub(r"\s+", " ", text).strip()

        # Fix spacing around punctuation
        text = re.sub(r"([.?!])\s*([a-zA-Z])", r"\1 \2", text)

        # Capitalize start of sentences
        def cap_sentence(match):
            return match.group(1) + match.group(2).upper()

        text = re.sub(r"(^|[.?!]\s+)([a-z])", cap_sentence, text)

        return text

    def _generate_diff_html(self, raw: str, clean: str, removed_items: List[Dict[str, Any]]) -> str:
        """Generates visual HTML diff with strikethroughs for removed fillers."""
        if not removed_items or raw == clean:
            return f"<span>{clean}</span>"

        html = raw
        # Sort removed words by length descending to replace cleanly
        unique_removed = sorted(
            list(set(item["word"] for item in removed_items)),
            key=len,
            reverse=True,
        )

        for word in unique_removed:
            pattern = re.compile(r"\b(" + re.escape(word) + r")\b", re.IGNORECASE)
            html = pattern.sub(r'<span class="removed-filler" title="Removed filler sound">\1</span>', html)

        return html
