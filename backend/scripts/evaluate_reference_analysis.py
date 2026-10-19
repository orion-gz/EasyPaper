"""Opt-in live evaluation on Attention Is All You Need (arXiv:1706.03762v7).

Uses the configured chat provider and incurs normal inference costs. Supply a
local PDF and output path; no document is imported into the library.
"""
import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import get_chat_model, get_chat_provider
from services.pdf_parser import extract_pages
from services.reference_analysis import collect_contexts, generate_analysis
from services.reference_parser import extract_reference_list
from services.section_parser import detect_sections

CASES = [
    ('20', 'method', {'method'}, 'Adam'),
    ('22', 'background', {'background'}, 'self-attentive'),
    ('12', 'critique_support', {'support', 'critique'}, 'Gradient flow'),
]


async def evaluate(pdf, language, selected_cases=None):
    cases = [case for case in CASES if not selected_cases or case[1] in selected_cases]
    pages = await asyncio.to_thread(extract_pages, str(pdf), 'pymupdf')
    references = extract_reference_list(pages)
    for key, _, _, title_fragment in cases:
        if title_fragment.lower() not in references.get(key, '').lower():
            raise ValueError(f'Expected reference [{key}] ({title_fragment}); supply arXiv:1706.03762v7')
    report = {'provider': get_chat_provider(), 'model': get_chat_model(), 'cases': [], 'issues': []}
    for key, label, expected_roles, _ in cases:
        print(f'Evaluating {label} reference [{key}]', file=sys.stderr, flush=True)
        contexts = collect_contexts(pages, key)
        try:
            result = await asyncio.wait_for(generate_analysis(references[key], contexts,
                'Attention Is All You Need', detect_sections(pages), language, ref_key=key), timeout=480)
            report['cases'].append({'case': label, 'ref_key': key, 'result': result})
            if result['status'] != 'complete' or not expected_roles.intersection(result['roles']):
                report['issues'].append(f'{label}: missing expected role or incomplete analysis')
            if label == 'background' and result['method_score'] != 0:
                report['issues'].append('Background-only example received method dependency points')
            print(f"Result {label}: score={result['score']}, roles={result['roles']}", file=sys.stderr, flush=True)
        except Exception as exc:
            report['issues'].append(f'{label}: {type(exc).__name__}: {exc}')
    scores = {case['case']: case['result']['score'] for case in report['cases']}
    if scores.get('method') is not None and scores.get('background') is not None:
        if scores['method'] <= scores['background']:
            report['issues'].append('Method dependency should outrank the background example')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--language', default='ko')
    parser.add_argument('--case', action='append', choices=[case[1] for case in CASES],
                        help='Evaluate only this case (repeatable); defaults to all cases')
    args = parser.parse_args()
    report = asyncio.run(evaluate(args.pdf, args.language, args.case))
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(f"Wrote {args.output}; {len(report['issues'])} issue(s). Check reasons against the source PDF.")
    return bool(report['issues'])


if __name__ == '__main__':
    raise SystemExit(main())
