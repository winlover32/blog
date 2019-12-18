import {getActiveBreakpoint} from './breakpoints';
import {timeOrigin} from './performance';
import {initialSWState} from './sw-state';
import {uuid} from './uuid';
import {Logger} from './Logger';
import * as visibilitychange from './visibilitychange';


/* global CD_BREAKPOINT */ // 'cd1'
/* global CD_PIXEL_DENSITY */ // 'cd2'
/* global CD_HIT_SOURCE */ // 'cd4'
/* global CD_EFFECTIVE_CONNECTION_TYPE */ // 'cd5'
/* global CD_SERVICE_WORKER_STATE */ // 'cd9'
/* global CD_WINDOW_ID */ // 'cd11'
/* global CD_VISIBILITY_STATE */ // 'cd12'
/* global CD_HIT_TIME */ // 'cd15'
/* global CD_TRACKING_VERSION */ // 'cd16'

/* global CM_FCP */ // 'cm1',
/* global CM_FCP_SAMPLE */ // 'cm2',
/* global CM_NT_SAMPLE */ // 'cm3',
/* global CM_DOM_LOAD_TIME */ // 'cm4',
/* global CM_WINDOW_LOAD_TIME */ // 'cm5',
/* global CM_REQUEST_START_TIME */ // 'cm6',
/* global CM_RESPONSE_END_TIME */ // 'cm7',
/* global CM_RESPONSE_START_TIME */ // 'cm8',
/* global CM_WORKER_START_TIME */ // 'cm9',
/* global CM_FID */ // 'cm10',
/* global CM_FID_SAMPLE */ // 'cm11',
/* global CM_LCP */ // 'cm12',
/* global CM_LCP_SAMPLE */ // 'cm13',
/* global CM_CLS */ // 'cm14',
/* global CM_CLS_SAMPLE */ // 'cm15',


/**
 * Bump this when making backwards incompatible changes to the tracking
 * implementation. This allows you to create a segment or view filter
 * that isolates only data captured with the most recent tracking changes.
 */
const TRACKING_VERSION = '61';

export const log = new Logger((params, state) => {
  params[CD_HIT_TIME] = state.time;
  params[CD_VISIBILITY_STATE] = state.visibilityState;
});


const whenWindowLoaded = new Promise((resolve) => {
  if (document.readyState === 'complete') {
    resolve();
  } else {
    addEventListener('load', function f() {
      resolve();
      removeEventListener('load', f);
    });
  }
});


const perfObserve = (type, callback) => {
  if (typeof PerformanceObserver !== 'undefined' &&
      PerformanceObserver.supportedEntryTypes &&
      PerformanceObserver.supportedEntryTypes.includes(type)) {
    try {
      const po = new PerformanceObserver(callback);
      po.observe({type, buffered: true});
      return po;
    } catch (err) {
      // Do nothing.
    }
  }
};


/**
 * Initializes all the analytics setup. Creates trackers and sets initial
 * values on the trackers.
 */
export const init = async () => {
  log.set({
    [CD_BREAKPOINT]: getActiveBreakpoint().name,
    [CD_PIXEL_DENSITY]: getPixelDensity(),
    [CD_TRACKING_VERSION]: TRACKING_VERSION,
    // [CD_CLIENT_ID]: log.get('cid'), // TODO: set on the server.
    [CD_WINDOW_ID]: uuid(),
    [CD_SERVICE_WORKER_STATE]: initialSWState,
  });

  const effectiveConnectionType = getEffectiveConnectionType();
  if (effectiveConnectionType) {
    log.set({[CD_EFFECTIVE_CONNECTION_TYPE]: effectiveConnectionType});
  }

  trackErrors();

  log.send('pageview', {[CD_HIT_SOURCE]: 'navigation'});

  if (window.__wasAlwaysVisible) {
    trackFcp();
    trackLcp();
    trackFid();
    trackNavigationTimingMetrics();
  }
  trackCls();
};


/**
 * Tracks a JavaScript error with optional fields object overrides.
 * This function is exported so it can be used in other parts of the codebase.
 * E.g.:
 *
 *    `fetch('/api.json').catch(trackError);`
 *
 * @param {*=} err
 * @param {ParamOverrides=} paramOverrides
 */
export const trackError = (err = {}, paramOverrides = {}) => {
  log.send('event', Object.assign({
    ec: 'Error',
    ev: err.name || '(no error name)',
    el: `${err.message}\n${err.stack || '(no stack trace)'}`,
    ni: '1',
  }, paramOverrides));
};


/**
 * Tracks any errors that may have occurred on the page prior to analytics being
 * initialized, then adds an event handler to track future errors.
 */
const trackErrors = () => {
  // Errors that have occurred prior to this script running are stored on
  // `window.__e.q`, as specified in `index.html`.
  const loadErrorEvents = window.__e && window.__e.q || [];

  const trackErrorEvent = (event) => {
    // Use a different `ec` value for uncaught errors.
    const paramOverrides = {ec: 'Uncaught Error'};

    // Some browsers don't have an error property, so we fake it.
    const err = event.error || {
      message: `${event.message} (${event.lineno}:${event.colno})`,
    };

    trackError(err, paramOverrides);
  };

  // Replay any stored load error events.
  for (const event of loadErrorEvents) {
    trackErrorEvent(event);
  }

  // Add a new listener to track event immediately.
  window.addEventListener('error', trackErrorEvent);
};


const trackFcp = () => {
  perfObserve('paint', (list, observer) => {
    const entry = list.getEntriesByName('first-contentful-paint')[0];
    if (entry) {
      const fcp = Math.round(entry.startTime);
      log.send('event', {
        ec: 'Performance',
        ea: 'first-contentful-paint',
        ev: fcp,
        ni: '1',
        [CM_FCP]: fcp,
        [CM_FCP_SAMPLE]: 1,
      });
      observer.disconnect();
    }
  });
};


const trackLcp = async () => {
  // Since we don't load any content post-load. We can be confident the
  // last LCP candidate at this point is not going to change.
  // NOTE: will not be needed after this issue is resolved:
  // https://github.com/WICG/largest-contentful-paint/issues/43
  await whenWindowLoaded;

  perfObserve('largest-contentful-paint', (list, observer) => {
    const entries = list.getEntries();
    const lastEntry = entries[entries.length - 1];
    const lcp = Math.round(lastEntry.startTime);

    log.send('event', {
      ec: 'Performance',
      ea: 'largest-contentful-paint',
      el: String(window.__hadInput || window.__hadScroll),
      ev: lcp,
      ni: '1',
      [CM_LCP]: Math.round(lcp),
      [CM_LCP_SAMPLE]: 1,
    });
    observer.disconnect();
  });
};

const trackFid = () => {
  window.perfMetrics.onFirstInputDelay((delay, event) => {
    const fid = Math.round(delay);

    log.send('event', {
      ec: 'Performance',
      ea: 'first-input-delay',
      el: event.type,
      ev: fid,
      ni: '1',
      [CM_FID]: fid,
      [CM_FID_SAMPLE]: 1,
    });
  });
};


const trackCls = () => {
  // Stores the current layout shift score for the page.
  let cls = 0;

  // Detects new layout shift occurrences and updates the
  // `cls` variable.
  const observer = perfObserve('layout-shift', (list) => {
    for (const entry of list.getEntries()) {
      // Only count layout shifts without recent user input.
      if (!entry.hadRecentInput) {
        cls += entry.value;
      }
    }
  });

  // If `observer` is undefined it means the browser doesn't support
  // tracing `layout-shift` entries via `PerformanceObserver`.
  if (observer) {
    // Sends the final score to your analytics back end once
    // the page's lifecycle state becomes hidden.
    visibilitychange.addListener(function fn({visibilityState}) {
      if (visibilityState === 'hidden') {
        visibilitychange.removeListener(fn);

        // Force any pending records to be dispatched.
        observer.takeRecords();
        observer.disconnect();

        const kCls = Math.round(cls * 1000);
        log.send('event', {
          ec: 'Performance',
          ea: 'cumulative-layout-shift',
          ev: kCls,
          ni: '1',
          [CM_CLS]: kCls,
          [CM_CLS_SAMPLE]: 1,
        });
      }
    });
  }
};


/**
 * Gets the DOM and window load times and sends them as custom metrics to
 * Google Analytics via an event hit.
 */
const trackNavigationTimingMetrics = async () => {
  // Only track performance in supporting browsers.
  if (window.performance &&
      window.performance.timing &&
      window.performance.getEntriesByType) {
    await whenWindowLoaded;

    let nt = performance.getEntriesByType('navigation')[0];

    // Fall back to the performance timeline in browsers that don't
    // support Navigation Timing Level 2.
    if (!nt) {
      const pt = performance.timing;
      nt = {
        workerStart: 0,
        requestStart: pt.requestStart - timeOrigin,
        responseStart: pt.responseStart - timeOrigin,
        responseEnd: pt.responseEnd - timeOrigin,
        domContentLoadedEventStart: pt.domContentLoadedEventStart - timeOrigin,
        loadEventStart: pt.loadEventStart - timeOrigin,
      };
    }

    if (nt) {
      const requestStart = Math.round(nt.requestStart);
      const responseStart = Math.round(nt.responseStart);
      const responseEnd = Math.round(nt.responseEnd);
      const domLoaded = Math.round(nt.domContentLoadedEventStart);
      const windowLoaded = Math.round(nt.loadEventStart);

      // In some edge cases browsers return very obviously incorrect NT values,
      // e.g. negative or future times. This validates values before sending.
      const allValuesAreValid = (...values) => {
        return values.every((value) => value >= 0 && value < 6e6);
      };

      if (allValuesAreValid(
          requestStart, responseStart, responseEnd, domLoaded, windowLoaded)) {
        const paramOverrides = {
          ec: 'Performance',
          ea: 'navigation',
          ni: '1',
          [CM_NT_SAMPLE]: 1,
          [CM_REQUEST_START_TIME]: requestStart,
          [CM_RESPONSE_START_TIME]: responseStart,
          [CM_RESPONSE_END_TIME]: responseEnd,
          [CM_DOM_LOAD_TIME]: domLoaded,
          [CM_WINDOW_LOAD_TIME]: windowLoaded,
        };
        if (initialSWState === 'controlled' && 'workerStart' in nt) {
          paramOverrides[CM_WORKER_START_TIME] = Math.round(nt.workerStart);
        }
        log.send('event', paramOverrides);
      }
    }
  }
};

/**
 * Gets the effective connection type information if available.
 * @return {string}
 */
const getEffectiveConnectionType = () => {
  return navigator.connection && navigator.connection.effectiveType;
};


const getPixelDensity = () => {
  const densities = [
    ['1x', 'all'],
    ['1.5x', '(-webkit-min-device-pixel-ratio: 1.5),(min-resolution: 144dpi)'],
    ['2x', '(-webkit-min-device-pixel-ratio: 2),(min-resolution: 192dpi)'],
  ];
  let activeDensity;
  for (const [density, query] of densities) {
    if (window.matchMedia(query).matches) {
      activeDensity = density;
    }
  }
  return activeDensity;
};
