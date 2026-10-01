// dsh-ops-monitor - Client half
//
// A floating panel over the whole frame that streams the agent's tool calls.
// Reads the Host half's `feed` RPC (falling back to the HTTP route) and
// re-renders on a short interval.
//
// Written by hand in the lazy-CJS bundle protocol used by dsh web plugins:
// window.__ModuleLoader__.load with a factory returning cordis-plugin exports.
// No build step, no imports from dsh client packages.

window.__ModuleLoader__.load({
  id: 'dsh-ops-monitor',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var POLL_MS = 1000;
    var MAX_ROWS = 200;

    // Colour per operation class, so a glance is enough to tell a write from
    // a read. `exec` is deliberately loud: it is the class a FileSystemWatcher
    // can never see.
    var CLS_COLOR = {
      exec: '#7ee787',
      write: '#ffd866',
      edit: '#ffd866',
      read: '#79c0ff',
      search: '#79c0ff',
      fetch: '#d2a8ff',
      delegate: '#ffa657',
      approval: '#ff7b72',
      ask: '#ffa657',
      deliver: '#7ee787',
      other: '#8b949e',
    };

    function fmtTime(t) {
      try {
        var d = new Date(t);
        var p = function (n) { return String(n).padStart(2, '0'); };
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
      } catch (e) {
        return '--:--:--';
      }
    }

    function FeedPanel(props) {
      var React = props.React;
      var ctx = props.ctx;

      var state = React.useState({ entries: [], total: 0, error: null, open: true });
      var st = state[0];
      var setSt = state[1];

      var listRef = React.useRef(null);
      var stickRef = React.useRef(true);

      React.useEffect(function () {
        var alive = true;
        var timer = null;

        function apply(snapshot) {
          if (!alive || !snapshot || !Array.isArray(snapshot.entries)) return;
          setSt(function (prev) {
            return { entries: snapshot.entries, total: snapshot.total || 0, error: null, open: prev.open };
          });
        }

        function tick() {
          // preferred path: the package-private RPC to this plugin's Host half
          var p;
          try {
            if (ctx && ctx.host && typeof ctx.host.call === 'function') {
              p = ctx.host.call('feed', { limit: MAX_ROWS });
            } else {
              p = null;
            }
          } catch (e) {
            p = null;
          }

          if (!p || typeof p.then !== 'function') {
            // fallback: the HTTP route registered by the Host half
            p = fetch('/ops-feed?limit=' + MAX_ROWS, { credentials: 'same-origin' })
              .then(function (r) { return r.json(); });
          }

          p.then(apply).catch(function (err) {
            if (!alive) return;
            setSt(function (prev) {
              return { entries: prev.entries, total: prev.total, error: String(err && err.message ? err.message : err), open: prev.open };
            });
          });
        }

        tick();
        timer = setInterval(tick, POLL_MS);

        return function () {
          alive = false;
          if (timer) clearInterval(timer);
        };
      }, []);

      React.useEffect(function () {
        var el = listRef.current;
        if (el && stickRef.current) el.scrollTop = el.scrollHeight;
      });

      if (!st.open) {
        return React.createElement(
          'div',
          {
            onClick: function () { setSt(function (p) { return { entries: p.entries, total: p.total, error: p.error, open: true }; }); },
            style: {
              position: 'absolute', right: '14px', bottom: '14px',
              background: 'rgba(13,17,23,0.92)', color: '#7ee787',
              border: '1px solid #30363d', borderRadius: '8px',
              padding: '6px 12px', cursor: 'pointer',
              font: '12px/1.4 ui-monospace, Menlo, Consolas, monospace',
            },
          },
          'DSH OPS · ' + st.total
        );
      }

      var rows = st.entries.slice().reverse().map(function (e, i) {
        var color = CLS_COLOR[e.cls] || CLS_COLOR.other;
        return React.createElement(
          'div',
          { key: String(i) + String(e.t), style: { whiteSpace: 'nowrap', marginBottom: '1px' } },
          React.createElement('span', { style: { color: '#6e7681' } }, fmtTime(e.t) + ' '),
          React.createElement('span', { style: { color: color, display: 'inline-block', minWidth: '74px' } },
            String(e.name || '?')),
          React.createElement('span', { style: { color: e.isError ? '#ff7b72' : '#c9d1d9' } },
            (e.args ? ' ' + String(e.args) : '') + (e.isError ? '  ✗ ' + String(e.error || '') : ''))
        );
      });

      return React.createElement(
        'div',
        {
          style: {
            position: 'absolute', right: '14px', bottom: '14px',
            width: '620px', maxWidth: '46vw', height: '300px',
            display: 'flex', flexDirection: 'column',
            background: 'rgba(13,17,23,0.94)',
            border: '1px solid #30363d', borderRadius: '10px',
            boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
            font: '12px/1.45 ui-monospace, Menlo, Consolas, monospace',
            color: '#c9d1d9', overflow: 'hidden', zIndex: 60,
          },
        },
        React.createElement(
          'div',
          {
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '6px 10px', borderBottom: '1px solid #30363d',
              background: 'rgba(22,27,34,0.9)', color: '#8b949e',
            },
          },
          React.createElement('span', null, 'DSH OPS MONITOR · ' + st.total + ' ops'),
          React.createElement(
            'span',
            null,
            React.createElement('span', {
              onClick: function () { setSt(function (p) { return { entries: p.entries, total: p.total, error: p.error, open: false }; }); },
              style: { cursor: 'pointer', padding: '0 6px' },
              title: 'collapse',
            }, '—'),
          )
        ),
        st.error
          ? React.createElement('div', { style: { padding: '4px 10px', color: '#ff7b72' } }, 'feed error: ' + st.error)
          : null,
        React.createElement(
          'div',
          {
            ref: listRef,
            onScroll: function (ev) {
              var el = ev.target;
              stickRef.current = (el.scrollHeight - el.scrollTop - el.clientHeight) < 24;
            },
            style: { flex: '1 1 auto', overflowY: 'auto', padding: '6px 10px' },
          },
          rows.length ? rows : React.createElement('div', { style: { color: '#6e7681' } }, 'no operations recorded yet')
        ),
        React.createElement(
          'div',
          { style: { padding: '4px 10px', borderTop: '1px solid #30363d', color: '#6e7681' } },
          'green = shell command (invisible to file watchers) · newest first'
        )
      );
    }

    exports.name = 'dsh-ops-monitor-client';
    exports.inject = [];
    exports.apply = function (ctx) {
      // `slots` is optional: without it the plugin simply renders nothing.
      if (typeof ctx.inject !== 'function') return;
      ctx.inject(['slots'], function (scope) {
        scope.slots.inject('shell.overlay', function* () {
          yield scope.slots.register(
            { name: 'shell.overlay', id: 'dsh-ops-monitor', order: 50 },
            function OverlayEntry() {
              return FeedPanel({ React: scope.React, ctx: scope });
            }
          );
        });
      });
    };

    return module.exports;
  },
});
