import argparse
import functools
import http.server
import json
import pathlib
import shutil
import tempfile
import subprocess
import threading
import time

import httpx
import websocket


ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = pathlib.Path(tempfile.mkdtemp(prefix='typeandsee-browser-test-'))


class Browser:
    def __init__(self, url):
        self.log = (ARTIFACTS / 'chrome.log').open('w')
        self.profile = ARTIFACTS / 'profile'
        (self.profile / 'DevToolsActivePort').unlink(missing_ok=True)
        self.process = subprocess.Popen([
            shutil.which('google-chrome') or shutil.which('chromium') or 'google-chrome', '--headless', '--no-sandbox', '--disable-gpu',
            '--hide-scrollbars', '--window-size=1280,1100', '--remote-debugging-port=0',
            '--disable-background-timer-throttling', f'--user-data-dir={self.profile}', 'about:blank'
        ], stdout=self.log, stderr=subprocess.STDOUT)
        for _ in range(100):
            if (self.profile / 'DevToolsActivePort').exists():
                break
            time.sleep(.1)
        port = (self.profile / 'DevToolsActivePort').read_text().splitlines()[0]
        targets = httpx.get(f'http://127.0.0.1:{port}/json/list').json()
        target = next(item for item in targets if item['type'] == 'page')
        self.ws = websocket.create_connection(target['webSocketDebuggerUrl'], timeout=180, suppress_origin=True)
        self.counter = 0
        self.errors = []
        self.call('Runtime.enable')
        self.call('Page.navigate', {'url': url})

    def call(self, method, params=None):
        self.counter += 1
        request = self.counter
        self.ws.send(json.dumps({'id': request, 'method': method, 'params': params or {}}))
        while True:
            reply = json.loads(self.ws.recv())
            if reply.get('method') == 'Runtime.exceptionThrown':
                self.errors.append(reply['params'])
            if reply.get('id') == request:
                if 'error' in reply:
                    raise RuntimeError(reply['error'])
                return reply.get('result', {})

    def evaluate(self, expression, await_promise=False):
        result = self.call('Runtime.evaluate', {'expression': expression, 'returnByValue': True, 'awaitPromise': await_promise})
        if 'exceptionDetails' in result:
            raise RuntimeError(result['exceptionDetails'])
        return result.get('result', {}).get('value')

    def wait(self, expression, timeout=600):
        start = time.monotonic()
        last = None
        while time.monotonic() - start < timeout:
            value = self.evaluate(expression)
            if value:
                return value
            status = self.evaluate("document.getElementById('status')?.textContent")
            if status and status != last:
                print(status, flush=True)
                last = status
            time.sleep(1)
        raise RuntimeError({'timeout': expression, 'errors': self.errors})

    def close(self):
        self.ws.close()
        self.process.terminate()
        try:
            self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.log.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--seed', action='store_true')
    parser.add_argument('--url')
    args = parser.parse_args()
    server = None
    if not args.url:
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / 'web/images'))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f'http://127.0.0.1:{server.server_port}/'
    else:
        url = args.url
    browser = Browser(url)
    report = {'url': url, 'queries': []}
    try:
        browser.wait("document.getElementById('status')?.textContent?.startsWith('Ready.')", timeout=60)
        if args.seed:
            browser.evaluate("""window.seedState = {done: false};
                (async () => { try {
                    const app = await import('./app.js');
                    const sources = await (await fetch('./demo/sources.json')).json();
                    const output = [];
                    for (const source of sources) {
                        window.seedState.current = source.name;
                        source.vector = await app.embed('image', new URL(source.asset, location.href).href);
                        output.push(source);
                    }
                    window.seedOutput = output;
                    window.seedState.done = true;
                } catch (error) { window.seedState = {done: true, error: error.message, stack: error.stack}; } })(); 'started';""")
            browser.wait('window.seedState?.done')
            state = json.loads(browser.evaluate('JSON.stringify(window.seedState)'))
            if state.get('error'):
                raise RuntimeError(state)
            output = browser.evaluate('JSON.stringify(window.seedOutput)')
            (ROOT / 'web/images/demo/collection.json').write_text(output + '\n')
            print('Saved demo embeddings', len(json.loads(output)), flush=True)
            previous_origin = browser.evaluate('performance.timeOrigin')
            browser.call('Page.reload', {'ignoreCache': True})
            browser.wait(f'performance.timeOrigin !== {previous_origin}', timeout=30)
            browser.wait("document.getElementById('status')?.textContent?.startsWith('Ready.')", timeout=60)
        for query, expected in [
            ('a golden dog', 'A golden retriever outside'),
            ('a cat', 'A cat in the garden'),
            ('mountains beside a lake', 'Mountains beside a blue lake'),
            ('bicycles parked outside', 'Bicycles parked outside'),
            ('a glass of orange juice', 'A glass of orange juice'),
        ]:
            browser.evaluate(f"document.getElementById('query').value={json.dumps(query)}; (async () => {{ const app = await import('./app.js'); await app.searchQuery({json.dumps(query)}); return true; }})()", await_promise=True)
            result = json.loads(browser.evaluate("JSON.stringify({first: document.querySelector('.card h3')?.textContent, status: document.getElementById('status').textContent, count: document.querySelectorAll('.card').length})"))
            assert result['first'] == expected, (query, result)
            report['queries'].append({'query': query, **result})
            print(json.dumps(report['queries'][-1]), flush=True)
        browser.wait("[...document.querySelectorAll('.card img')].every(image => image.complete && image.naturalWidth > 0)", timeout=30)
        browser.call('DOM.enable')
        def upload():
            root = browser.call('DOM.getDocument')['root']['nodeId']
            node = browser.call('DOM.querySelector', {'nodeId': root, 'selector': '#files'})['nodeId']
            browser.call('DOM.setFileInputFiles', {'nodeId': node, 'files': [str(ROOT / 'web/images/demo/dog.jpg')]})
        upload()
        browser.wait("document.getElementById('status')?.textContent?.startsWith('Added 1 photo')")
        assert browser.evaluate("document.querySelectorAll('.card').length") == 6
        previous_origin = browser.evaluate('performance.timeOrigin')
        browser.call('Page.reload', {'ignoreCache': True})
        browser.wait(f'performance.timeOrigin !== {previous_origin}', timeout=30)
        browser.wait("document.getElementById('status')?.textContent?.startsWith('Ready.')", timeout=60)
        assert browser.evaluate("document.querySelectorAll('.card').length") == 6
        upload()
        browser.wait("document.getElementById('status')?.textContent?.startsWith('Added 0 photos, skipped 1 duplicate')")
        assert browser.evaluate("document.querySelectorAll('.card').length") == 6
        browser.evaluate("window.confirm = () => true; document.getElementById('reset').click();")
        browser.wait("document.getElementById('status')?.textContent === 'Demo collection restored.'")
        assert browser.evaluate("document.querySelectorAll('.card').length") == 5
        report['imports'] = {'image_embedding': 'passed', 'reload_persistence': 'passed', 'duplicate_detection': 'passed', 'reset': 'passed'}
        print(json.dumps(report['imports']), flush=True)
        browser.evaluate("document.getElementById('query').value='mountains beside a lake'; (async () => { const app = await import('./app.js'); await app.searchQuery('mountains beside a lake'); return true; })()", await_promise=True)
        browser.wait("[...document.querySelectorAll('.card img')].every(image => image.complete && image.naturalWidth > 0)", timeout=30)
        import base64
        time.sleep(.4)
        screenshot = browser.call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': True})
        (ARTIFACTS / 'search.png').write_bytes(base64.b64decode(screenshot['data']))
        report['browser_errors'] = browser.errors
        report['status'] = 'passed'
        (ARTIFACTS / 'report.json').write_text(json.dumps(report, indent=2))
        print('PASS', str(ARTIFACTS / 'report.json'), flush=True)
    finally:
        browser.close()
        if server:
            server.shutdown()


if __name__ == '__main__':
    main()
