"""render_image_crop_bytes()의 min_output_width 자동 확대 동작 테스트.

지식 그래프 Figure/Table 노드 상세 패널이 이미지를 패널 폭에 맞춰 확대
표시하는데(width:100%), 번호 매겨진 수식처럼 원본 크롭 영역이 아주 작으면
고정 zoom으로는 저해상도로 렌더링되어 확대 시 흐려 보였다. min_output_width를
주면 작은 영역일수록 zoom을 자동으로 키워 최소 출력 폭을 보장해야 한다."""

import io

import fitz
from PIL import Image

from services.pdf_parser import render_image_crop_bytes


def _make_pdf(tmp_path, width=595, height=842):
    doc = fitz.open()
    page = doc.new_page(width=width, height=height)
    page.insert_text((72, 72), "Hello world, this is a test PDF page.")
    pdf_path = tmp_path / "test.pdf"
    doc.save(str(pdf_path))
    doc.close()
    return str(pdf_path)


def _png_size(png_bytes):
    return Image.open(io.BytesIO(png_bytes)).size


def test_render_image_crop_bytes_without_min_width_uses_flat_zoom(tmp_path):
    pdf_path = _make_pdf(tmp_path)
    # 페이지 폭(595pt)의 50%를 zoom=2.0으로 크롭하면 출력 폭은 약 595px가 되어야 한다.
    bbox = {"left": 0.0, "top": 0.0, "width": 50.0, "height": 20.0}
    png_bytes = render_image_crop_bytes(pdf_path, 1, bbox, zoom=2.0)
    assert png_bytes is not None
    width_px, _ = _png_size(png_bytes)
    assert abs(width_px - 595) <= 2


def test_render_image_crop_bytes_small_bbox_scales_up_to_min_width(tmp_path):
    pdf_path = _make_pdf(tmp_path)
    # 페이지 폭의 30%(약 178.5pt)인 영역 - zoom=2.0이면 357px밖에 안 나와
    # 패널에서 확대 표시(width:100%)하면 흐려진다. min_output_width=900을 주면
    # 필요한 zoom(약 5.04, max_zoom 6.0 이내)까지 자동으로 키워 900px 근처로
    # 렌더링돼야 한다.
    bbox = {"left": 0.0, "top": 0.0, "width": 30.0, "height": 10.0}
    png_bytes = render_image_crop_bytes(pdf_path, 1, bbox, zoom=2.0, min_output_width=900)
    assert png_bytes is not None
    width_px, _ = _png_size(png_bytes)
    assert 890 <= width_px <= 910


def test_render_image_crop_bytes_min_width_respects_max_zoom_cap(tmp_path):
    pdf_path = _make_pdf(tmp_path)
    # 극단적으로 작은 영역(페이지 폭의 1%)에 아주 큰 min_output_width를 요구해도
    # max_zoom 상한을 넘어서면 안 된다(과도한 렌더링 비용 방지).
    bbox = {"left": 0.0, "top": 0.0, "width": 1.0, "height": 1.0}
    png_bytes = render_image_crop_bytes(
        pdf_path, 1, bbox, zoom=2.0, min_output_width=5000, max_zoom=6.0
    )
    assert png_bytes is not None
    width_px, _ = _png_size(png_bytes)
    # 페이지 폭 595pt * 1% = 5.95pt, zoom 상한 6.0 적용 시 약 35.7px 정도만 나와야 한다.
    assert width_px <= 40
