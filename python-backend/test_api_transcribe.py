import requests
import time

url = 'http://127.0.0.1:8001/api/transcription/upload'
filepath = r'D:\Knowledge\FLD\english\录音\Recording 20260513151921.m4a'

with open(filepath, 'rb') as f:
    resp = requests.post(url, files={'file': f})
data = resp.json()
print('Task ID:', data.get('task_id'))
print('Status:', data.get('status'))

time.sleep(6)
task_id = data['task_id']
resp2 = requests.get(f'http://127.0.0.1:8001/api/transcription/task/{task_id}')
result = resp2.json()
print('Final Status:', result.get('status'))
print('Language:', result.get('language'))
print('Duration:', result.get('duration'))
for seg in (result.get('segments') or []):
    print(f"  [{seg['id']}] {seg['start']:.2f}-{seg['end']:.2f}: {seg['text']}")
