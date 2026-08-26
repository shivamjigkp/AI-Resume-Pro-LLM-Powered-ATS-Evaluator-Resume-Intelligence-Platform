import re

with open('resume_builder_1.html', 'r', encoding='utf-8') as f:
    html = f.read()

scripts = re.findall(r'<script>(.*?)</script>', html, re.DOTALL)
for i, s in enumerate(scripts):
    with open(f"script_{i}.js", "w", encoding="utf-8") as out:
        out.write(s)
print(f"Dumped {len(scripts)} scripts.")
