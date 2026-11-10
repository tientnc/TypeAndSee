"""Opt-in Chrome verification for the movie UI, ranking, imports, and local models."""

import argparse
import base64
import functools
import http.server
import json
import pathlib
import tempfile
import threading
import time

from browser_smoke import Browser, ROOT, ARTIFACTS


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url')
    args = parser.parse_args()
    server = None
    if args.url:
        url = args.url
    else:
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / 'web'))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f'http://127.0.0.1:{server.server_port}/'
    browser = Browser(url)
    report = {'url': url, 'checks': {}, 'evaluation': {}}
    try:
        browser.wait("document.querySelectorAll('.card').length > 0 && !document.getElementById('recommend-button').disabled", timeout=120)
        count = browser.evaluate("(async () => { window.movieApp = await import('./movies/app.js'); window.movieEngine = await movieApp.ready; return movieEngine.movies.length; })()", await_promise=True)
        assert count > 1000, count
        print('Loaded movie catalogue', count, flush=True)
        browser.evaluate("document.getElementById('film-search').value='Arrival'; document.getElementById('film-search').dispatchEvent(new Event('input', {bubbles:true}));")
        assert browser.evaluate("document.querySelectorAll('.option').length") > 0
        browser.evaluate("[...document.querySelectorAll('.option')].find(item => item.textContent.includes('2016')).click()")
        browser.wait("movieApp.snapshot().results?.length > 0 && movieApp.snapshot().trace?.some(step => step.step === 'Vector retrieval') && !document.getElementById('recommend-button').disabled")
        selected = browser.evaluate("JSON.stringify(movieApp.snapshot())")
        selected = json.loads(selected)
        assert len(selected['profile']) == 1
        assert not set(selected['profile']).intersection(item['id'] for item in selected['results'])
        report['checks']['title_selection_and_seen_exclusion'] = 'passed'
        print('Arrival recommendations', [item['title'] for item in selected['results'][:8]], flush=True)

        browser.evaluate("document.getElementById('runtime').value='90'; document.getElementById('min-year').value='2000'; document.getElementById('genre').value='Science Fiction'; movieApp.updateRecommendations()", await_promise=True)
        result = json.loads(browser.evaluate('JSON.stringify(movieApp.snapshot())'))
        assert result['results'], result
        assert all(item['runtime'] and item['runtime'] <= 90 and item['year'] >= 2000 and 'Science Fiction' in item['genres'] for item in result['results'])
        report['checks']['hard_filters'] = 'passed'
        browser.evaluate("document.getElementById('runtime').value=''; document.getElementById('min-year').value=''; document.getElementById('genre').value=''; movieApp.updateRecommendations()", await_promise=True)

        for long in [False, True]:
            expression = """(async () => {
              const movie = LONG ? movieEngine.movies.find(item => item.synopsis.length > 1600) : movieEngine.movies.find(item => item.title === 'Arrival' && item.year === 2016);
              const text = `${movie.title}. Genres: ${movie.genres.join(', ')}. Tags: ${(movie.keywords || []).join(', ')}. ${movie.synopsis}`;
              const output = await movieApp.embedDescription(text, {metadata:true}), vector = output.vector;
              return {id:movie.id,title: movie.title, dimensions: vector.length, inputTokens:output.inputTokens, tokenSignature:output.tokenSignature, cosine: vector.reduce((sum, value, i) => sum + value * movie.vector[i], 0)};
            })()""".replace('LONG', str(long).lower())
            print('Checking catalogue/browser encoder parity', 'long input' if long else 'short input', flush=True)
            parity = browser.evaluate(expression, await_promise=True)
            fixtures = json.loads((ROOT / 'catalogue/encoder-fixtures.json').read_text())
            reference = next(item for item in fixtures if item['id'] == parity['id'])
            assert parity['inputTokens'] == reference['inputTokens'] and parity['tokenSignature'] == reference['tokenSignature'], parity
            # CPU and WASM quantized kernels can differ numerically even with identical token IDs.
            assert parity['dimensions'] == 384 and parity['cosine'] > (.99 if long else .999), parity
            report['checks']['long_encoder_parity' if long else 'short_encoder_parity'] = parity
            print(json.dumps(parity), flush=True)
        browser.evaluate("document.getElementById('mood').value='space exploration under 120 minutes, no horror'; movieApp.updateRecommendations()", await_promise=True)
        mood = json.loads(browser.evaluate('JSON.stringify(movieApp.snapshot())'))
        assert mood['filters']['runtime'] == 119 and 'Horror' in mood['filters']['excludeGenres']
        assert mood['results'] and all(item['runtime'] and item['runtime'] <= 119 and 'Horror' not in item['genres'] for item in mood['results'])
        report['checks']['description_embedding_and_constraints'] = 'passed'
        browser.evaluate("document.getElementById('mood').value=''; movieApp.updateRecommendations()", await_promise=True)

        folder = pathlib.Path(tempfile.mkdtemp(prefix='typeandsee-csv-'))
        (folder / 'watched.csv').write_text('\ufeffDate,Name,Year,Letterboxd URI\r\n2025-01-01,The Matrix,1999,https://letterboxd.com/film/the-matrix/\r\n2025-01-01,"Paris, Texas",1984,\r\n2025-01-01,Not A Real Film,2099,\r\n2025-01-01,King Kong,,\r\n')
        (folder / 'ratings.csv').write_text('Date,Name,Year,Rating\n2025-01-01,Arrival,2016,4.5\n2025-01-01,Interstellar,2014,1.5\n2025-01-01,Memento,2000,4\n')
        (folder / 'watchlist.csv').write_text('Date,Name,Year\n2025-01-01,Coherence,2013\n')
        browser.call('DOM.enable')
        root = browser.call('DOM.getDocument')['root']['nodeId']
        node = browser.call('DOM.querySelector', {'nodeId': root, 'selector': '#csv-files'})['nodeId']
        browser.call('DOM.setFileInputFiles', {'nodeId': node, 'files': [str(folder / name) for name in ['watched.csv', 'ratings.csv', 'watchlist.csv']]})
        browser.wait("document.getElementById('import-summary').textContent.includes('6 matched rows') && !document.getElementById('recommend-button').disabled", timeout=40)
        imported = json.loads(browser.evaluate('JSON.stringify(movieApp.snapshot())'))
        assert browser.evaluate("document.getElementById('import-summary').textContent.includes('1 unmatched')")
        assert browser.evaluate("document.getElementById('import-summary').textContent.includes('1 ambiguous')")
        assert sum(item.get('status') == 'liked' for item in imported['profile'].values()) == 2
        assert sum(item.get('status') == 'disliked' for item in imported['profile'].values()) == 1
        assert not {id for id, entry in imported['profile'].items() if entry.get('status')}.intersection(item['id'] for item in imported['results'])
        report['checks']['letterboxd_csv_import'] = 'passed'
        browser.evaluate("document.getElementById('watchlist-only').checked=true; movieApp.updateRecommendations()", await_promise=True)
        watchlist = json.loads(browser.evaluate('JSON.stringify(movieApp.snapshot())'))
        assert len(watchlist['results']) == 1 and watchlist['results'][0]['title'] == 'Coherence'
        browser.evaluate("document.getElementById('watchlist-only').checked=false; movieApp.updateRecommendations()", await_promise=True)
        report['checks']['watchlist_is_not_watched'] = 'passed'

        previous = browser.evaluate('performance.timeOrigin')
        browser.call('Page.reload', {'ignoreCache': True})
        browser.wait(f'performance.timeOrigin !== {previous}', timeout=30)
        browser.wait("document.querySelectorAll('.card').length > 0 && !document.getElementById('recommend-button').disabled", timeout=120)
        browser.evaluate("(async () => { window.movieApp = await import('./movies/app.js'); window.movieEngine = await movieApp.ready; return true; })()", await_promise=True)
        restored = json.loads(browser.evaluate('JSON.stringify(movieApp.snapshot())'))
        assert restored['profile'] == imported['profile']
        report['checks']['reload_persistence'] = 'passed'
        browser.evaluate("document.getElementById('map-view').click()")
        assert browser.evaluate("document.querySelectorAll('.map-dot').length") == count
        browser.evaluate("document.querySelector('.map-dot.recommended').dispatchEvent(new MouseEvent('click',{bubbles:true}))")
        assert browser.evaluate("document.getElementById('film-dialog').open")
        assert browser.evaluate("document.querySelector('#film-detail .source-link').href.startsWith('https://en.wikipedia.org/')")
        browser.evaluate("document.getElementById('close-dialog').click(); document.getElementById('cards-view').click()")
        report['checks']['movie_map_and_sources'] = 'passed'

        cases = json.loads((ROOT / 'catalogue/evaluation.json').read_text())
        evaluation_script = """(async () => {
          const suite = SUITE, { normalizedTitle } = await import('./movies/engine.js');
          const lookup = ([title, year]) => movieEngine.movies.find(movie => normalizedTitle(movie.title) === normalizedTitle(title) && movie.year === year);
          const details = [];
          for (const test of suite.cases) {
            const seed = lookup(test.seed); if (!seed) throw new Error('Evaluation seed missing: ' + test.seed[0]);
            const targets = test.relevant.map(lookup); const ids = new Set(targets.filter(Boolean).map(movie => movie.id));
            const start = performance.now(); const result = await movieEngine.recommend({[seed.id]: {status: 'liked'}}, {}, null, suite.k); const elapsed = performance.now() - start;
            const ranked = result.results.map(item => item.movie); const baseline = movieEngine.movies.filter(movie => movie.id !== seed.id).sort((a,b) => b.revenue - a.revenue).slice(0,suite.k);
            const measure = items => { const hits = items.map(movie => ids.has(movie.id) ? 1 : 0); const dcg = hits.reduce((sum, hit, index) => sum + hit / Math.log2(index + 2), 0); const ideal = Array.from({length:Math.min(test.relevant.length,suite.k)}, (_,i) => 1/Math.log2(i+2)).reduce((a,b)=>a+b,0); return {recall: hits.reduce((a,b)=>a+b,0)/test.relevant.length, ndcg: dcg/ideal}; };
            details.push({seed:seed.title, ranked:ranked.map(movie=>movie.title), missingLabels:test.relevant.filter((_,i)=>!targets[i]), latency_ms:elapsed, content:measure(ranked), box_office_baseline:measure(baseline)});
          }
          return {description:suite.description,k:suite.k,details,mean_recall_at_k:details.reduce((s,t)=>s+t.content.recall,0)/details.length,mean_ndcg_at_k:details.reduce((s,t)=>s+t.content.ndcg,0)/details.length,baseline_mean_recall_at_k:details.reduce((s,t)=>s+t.box_office_baseline.recall,0)/details.length,external_model_cost_per_query_usd:0};
        })()""".replace('SUITE', json.dumps(cases))
        report['evaluation'] = browser.evaluate(evaluation_script, await_promise=True)
        print('Evaluation', json.dumps({key: value for key, value in report['evaluation'].items() if key != 'details'}), flush=True)
        time.sleep(.3)
        screenshot = browser.call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': True})
        (ARTIFACTS / 'movies.png').write_bytes(base64.b64decode(screenshot['data']))
        report['browser_errors'] = browser.errors
        assert not browser.errors, browser.errors
        report['status'] = 'passed'
        (ARTIFACTS / 'movie-report.json').write_text(json.dumps(report, indent=2))
        print('PASS', str(ARTIFACTS / 'movie-report.json'), flush=True)
    finally:
        (ARTIFACTS / 'movie-report.json').write_text(json.dumps(report, indent=2))
        print('Report', str(ARTIFACTS / 'movie-report.json'), flush=True)
        browser.close()
        if server:
            server.shutdown()


if __name__ == '__main__':
    main()
