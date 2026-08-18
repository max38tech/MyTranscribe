"""
Unit tests for DisfluencyCleaner in backend/cleaner.py
"""

import pytest
from backend.cleaner import DisfluencyCleaner


def test_cleaner_elongated_vocal_fillers():
    cleaner = DisfluencyCleaner()

    # Test the specific example from the user: "uuhmmm"
    res1 = cleaner.clean("Uuhmmm, we need to fix this.")
    assert res1["cleaned_text"] == "We need to fix this."
    assert res1["removed_count"] >= 1

    # Test various elongated spellings
    res2 = cleaner.clean("I think, uhh, this is, ummm, working, errr, properly.")
    assert res2["cleaned_text"] == "I think this is working properly."
    assert res2["removed_count"] == 3


def test_cleaner_sentence_capitalization_and_punctuation():
    cleaner = DisfluencyCleaner()

    # Leading filler should re-capitalize the following word
    res = cleaner.clean("Um, the meeting starts now. Uh, please join.")
    assert res["cleaned_text"] == "The meeting starts now. Please join."

    # Multiple trailing or orphan commas
    res_commas = cleaner.clean("So, uh, basically, um, we did it.")
    assert res_commas["cleaned_text"] == "So basically we did it."


def test_cleaner_repetitions():
    cleaner = DisfluencyCleaner(remove_repetitions=True)

    res = cleaner.clean("I I think that the the project is ready.")
    assert res["cleaned_text"] == "I think that the project is ready."

    # Triple repetition
    res_triplet = cleaner.clean("We we we can do it.")
    assert res_triplet["cleaned_text"] == "We can do it."


def test_cleaner_hyphen_stutters():
    cleaner = DisfluencyCleaner(remove_stutters=True)

    res = cleaner.clean("Th- that is awesome, I- I like it.")
    assert res["cleaned_text"] == "That is awesome, I like it."


def test_cleaner_verbal_crutches_toggle():
    # Disabled by default
    cleaner_default = DisfluencyCleaner(remove_verbal_crutches=False)
    res1 = cleaner_default.clean("It is like very fast, you know.")
    assert "like" in res1["cleaned_text"]
    assert "you know" in res1["cleaned_text"]

    # Enabled
    cleaner_crutches = DisfluencyCleaner(remove_verbal_crutches=True)
    res2 = cleaner_crutches.clean("It is like very fast, you know.")
    assert res2["cleaned_text"] == "It is very fast."


def test_cleaner_custom_fillers_and_whitelist():
    cleaner = DisfluencyCleaner(
        custom_fillers=["to be honest", "literally"],
        custom_preserve=["um"],
    )

    res = cleaner.clean("To be honest, this is literally cool, um yeah.")
    # 'to be honest' and 'literally' should be removed, but 'um' is whitelisted
    assert "literally" not in res["cleaned_text"]
    assert "To be honest" not in res["cleaned_text"]
    assert "um" in res["cleaned_text"].lower()


def test_diff_generation():
    cleaner = DisfluencyCleaner()
    res = cleaner.clean("This is, uuhmmm, a test.")
    assert res["removed_count"] == 1
    assert "removed-filler" in res["diff_html"]
    assert "uuhmmm" in res["diff_html"]
