from pathlib import Path

from PIL import Image, ImageDraw
from paddleocr import PaddleOCR

p = Path('D:/script/new/ocr_probe.png')
img = Image.new('RGB', (800, 400), 'white')
d = ImageDraw.Draw(img)
d.text((50, 50), 'Сотрудник\nA2ME3 101-86-90-E4\n26-08-2026\nРазмещение', fill='black')
img.save(p)

ocr = PaddleOCR(lang='ru', use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False)
res = ocr.predict(str(p))
print(type(res))
print(len(res))
print(repr(res[0]))
print(type(res[0]))
if isinstance(res[0], list):
    print('first list len', len(res[0]))
    for i, item in enumerate(res[0]):
        print('item', i, type(item), repr(item)[:500])
