import fitz,re,json,sys
from pathlib import Path
d=fitz.open(sys.argv[1])
result={};samples=[]
for i,page in enumerate(d):
 lines=[]
 for b in page.get_text('dict')['blocks']:
  for ln in b.get('lines',[]):
   spans=ln['spans'];t=''.join(s['text'] for s in spans).strip()
   if t and ln['bbox'][1]>50 and ln['bbox'][1]<810 and max(s['size'] for s in spans)>11:
    lines.append((t,any('Bold' in s['font'] or 'Hei' in s['font'] for s in spans)))
 candidates=[]
 for j,(t,bold) in enumerate(lines):
  if re.fullmatch(r'\d+[.、．]',t) and j+1<len(lines):t+=lines[j+1][0]
  numbered=re.match(r'^(?:\d{1,3}[.、．](?!\d)|[（(]\d{1,3}[)）])\s*\S',t)
  section=re.match(r'^\d{1,3}(?:\.\d{1,3}){1,3}\s+\S',t)
  next_api=j+1<len(lines) and lines[j+1][0].startswith(('函数原型','函数功能','函数作用'))
  if len(t)<95 and ((numbered and (bold or next_api or re.search(r'\(\)\s*函数$',t))) or (section and bold)):
   candidates.append(t)
 if candidates:result[str(i+1)]=list(dict.fromkeys(candidates))
Path(__file__).with_name('guide-source-headings.json').write_text(json.dumps(result,ensure_ascii=False))
print('pages',len(result),'candidate lines',sum(map(len,result.values())))
print(json.dumps(list(result.items())[60:68],ensure_ascii=False,indent=2))
