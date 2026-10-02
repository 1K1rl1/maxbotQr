from pathlib import Path
from PIL import Image, ImageDraw
from paddleocr import PaddleOCR

p = Path('D:/script/new/ocr_probe.png')
img = Image.new('RGB', (1200, 600), 'white')
d = ImageDraw.Draw(img)
d.text((80, 80), 'Сотрудник\nA2ME3 101-86-90-E4\n26-08-2026\nРазмещение\nЗадание', fill='black')
img.save(p)

ocr = PaddleOCR(lang='ru', use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False)
res = ocr.predict(str(p))
print('TYPE', type(res))
print('REPR_START')
print(repr(res)[:4000])
print('REPR_END')

if isinstance(res, (list, tuple)):
    print('LEN', len(res))
    for i, item in enumerate(res[:5]):
        print('ITEM', i, type(item))
        print(repr(item)[:1200])
        if isinstance(item, dict):
            print('DICT_KEYS', list(item.keys())[:30])
