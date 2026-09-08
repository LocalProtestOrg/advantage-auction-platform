import os,re,glob
base=os.path.abspath('fonts/node_modules/@fontsource')
fams={'cormorant-garamond':'Cormorant Garamond','jost':'Jost','playfair-display':'Playfair Display','lato':'Lato',
      'pinyon-script':'Pinyon Script','petit-formal-script':'Petit Formal Script','italiana':'Italiana'}
css=[]
for slug,fam in fams.items():
    for f in sorted(glob.glob(f'{base}/{slug}/files/{slug}-latin-*-*.woff2')):
        m=re.search(r'-latin-(\d+)-(normal|italic)\.woff2$',f)
        if not m: continue
        w,st=m.groups()
        css.append(f"@font-face{{font-family:'{fam}';font-style:{st};font-weight:{w};font-display:block;src:url('file://{f}') format('woff2')}}")
open('fonts/local-fonts.css','w').write('\n'.join(css))
print(len(css),'faces')
