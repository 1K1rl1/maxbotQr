from pathlib import Path
from PIL import Image, ImageDraw
from paddleocr import PaddleOCR

path = Path(r'D:\script\new\ocr_probe.png')
img = Image.new('RGB', (800, 400), 'white')
d = ImageDraw.Draw(img)
d.text((50, 50), 'Сотрудник\nA2ME3 101-86-90-E4\n26-08-2026\nРазмещение', fill='black')
img.save(path)

ocr = PaddleOCR(lang='ru', use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False)
res = ocr.predict(str(path))
print(type(res))
print('len=', len(res))
for idx, item in enumerate(res[:3]):
    print('ITEM', idx, type(item))
    print(repr(item)[:1000])
