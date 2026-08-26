import sys
with open('script_0.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

for i, line in enumerate(lines):
    if "Error fetching sheets for gate 2" in line:
        for j in range(i-2, i+5):
            if j < len(lines):
                print(f"{j+1}: {lines[j].rstrip()}")
