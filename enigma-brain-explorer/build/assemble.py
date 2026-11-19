"""Inject the extracted data and mesh into the HTML template to produce index.html.

Usage (from the repo root):
    python build/assemble.py build/out index.html
"""
import sys, pathlib

out_dir = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'build/out')
target = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else 'index.html')
here = pathlib.Path(__file__).parent

template = (here / 'template.html').read_text()
data = (out_dir / 'data.json').read_text().replace('</', '<\\/')   # keep the JSON safe inside a <script> tag
mesh = (out_dir / 'mesh.b64').read_text()

html = template.replace('__DATA__', data, 1).replace('__MESH__', mesh, 1)
target.write_text(html)
print(f'wrote {target} ({len(html) / 1e6:.1f} MB)')
