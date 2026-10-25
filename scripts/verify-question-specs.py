#!/usr/bin/env python3
"""Verify authored question-suite outputs and that an intentional bug is caught."""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUESTIONS_PATH = ROOT / "questions.json"
SPECS_PATH = ROOT / "question-specs.json"
ORACLES_PATH = ROOT / "test" / "question-oracles.json"
# These ten suites already have question-specific JavaScript reference/mutant checks
# in test/question-specs.test.js and live Judge0 verification in verify-live-judge.js.
JS_VERIFIED_IDS = {"3", "5", "6", "13", "14", "15", "17", "18", "22", "25"}


def normalized(text: str) -> str:
    return " ".join(text.split())


def run_program(source: str, stdin: str, question_id: str, role: str, case_no: int) -> str:
    try:
        result = subprocess.run(
            [sys.executable, "-I", "-S", "-c", source],
            input=stdin,
            text=True,
            capture_output=True,
            timeout=3,
            cwd=ROOT,
            env={"PATH": os.environ.get("PATH", ""), "PYTHONIOENCODING": "utf-8"},
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise AssertionError(f"Q{question_id} {role} timed out on case {case_no}") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()[:1000]
        raise AssertionError(f"Q{question_id} {role} exited {result.returncode} on case {case_no}: {detail}")
    if len(result.stdout) > 100_000:
        raise AssertionError(f"Q{question_id} {role} produced excessive output on case {case_no}")
    return result.stdout


def main() -> int:
    questions = json.loads(QUESTIONS_PATH.read_text(encoding="utf-8"))
    specs = json.loads(SPECS_PATH.read_text(encoding="utf-8"))
    oracles = json.loads(ORACLES_PATH.read_text(encoding="utf-8"))
    question_by_id = {str(question["id"]): question for question in questions}
    expected_ids = set(question_by_id)
    spec_ids = set(specs)
    allow_partial = "--allow-partial" in sys.argv
    extra = spec_ids - expected_ids
    missing = expected_ids - spec_ids
    if extra or (missing and not allow_partial):
        raise AssertionError(f"Question suite coverage mismatch; missing={sorted(missing, key=int)}, extra={sorted(extra, key=int)}")
    if set(oracles) - expected_ids:
        raise AssertionError(f"Oracle data contains unknown question IDs: {sorted(set(oracles) - expected_ids, key=int)}")
    no_oracle = spec_ids - set(oracles)
    if not no_oracle <= JS_VERIFIED_IDS:
        raise AssertionError(f"Question IDs lack executable reference/mutant validation: {sorted(no_oracle - JS_VERIFIED_IDS, key=int)}")

    case_total = 0
    for question_id, suite in specs.items():
        question = question_by_id[question_id]
        level = int(question.get("lvl", 1))
        sample_tests = suite.get("sampleTests", [])
        hidden_tests = suite.get("hiddenTests", [])
        if len(sample_tests) < 2 or len(hidden_tests) < 3:
            raise AssertionError(f"Q{question_id} needs at least two samples and three hidden tests")
        if level == 3 and len(hidden_tests) < 4:
            raise AssertionError(f"Q{question_id} is level 3 and needs at least four hidden tests")
        if level >= 4 and len(hidden_tests) < 5:
            raise AssertionError(f"Q{question_id} is level 4 and needs at least five hidden tests")
        if not all(suite.get(key) for key in ("inputFormat", "outputFormat", "constraints")):
            raise AssertionError(f"Q{question_id} is missing an input/output format or constraints")
        cases = sample_tests + hidden_tests
        for index, case in enumerate(cases, 1):
            if not isinstance(case.get("input"), str) or not isinstance(case.get("expectedOutput"), str):
                raise AssertionError(f"Q{question_id} case {index} must have string input and expectedOutput")

        oracle = oracles.get(question_id)
        if oracle:
            reference = oracle.get("referencePython", "")
            mutant = oracle.get("incorrectPython", "")
            if not reference or not mutant:
                raise AssertionError(f"Q{question_id} is missing its Python reference or intentional mutant")
            mutant_caught = False
            for index, case in enumerate(cases, 1):
                expected = normalized(case["expectedOutput"])
                actual = normalized(run_program(reference, case["input"], question_id, "reference", index))
                if actual != expected:
                    raise AssertionError(f"Q{question_id} reference disagrees with case {index}: expected {expected!r}, got {actual!r}")
                mutated = normalized(run_program(mutant, case["input"], question_id, "mutant", index))
                if mutated != expected:
                    mutant_caught = True
            if not mutant_caught:
                raise AssertionError(f"Q{question_id} tests do not catch its intentional bug")
        case_total += len(cases)
        print(f"Q{question_id}: {len(sample_tests)} visible + {len(hidden_tests)} hidden; outputs and mutant checked")

    suffix = " (partial coverage allowed)" if missing else ""
    print(f"Verified {len(specs)} questions and {case_total} cases{suffix}.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
