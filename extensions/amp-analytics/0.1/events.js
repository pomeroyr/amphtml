/**
 * Copyright 2017 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {CommonSignals} from '../../../src/common-signals';
import {Observable} from '../../../src/observable';
import {
  PlayingStates,
  VideoAnalyticsDetailsDef,
  VideoAnalyticsEvents,
} from '../../../src/video-interface';
import {
  getTrackerKeyName,
  getTrackerTypesForTimerEventTracker,
  getTrackerTypesForVisibilityTracker,
  isVideoTriggerType,
  isReservedTriggerType,
} from './event-types';
import {dev, user} from '../../../src/log';
import {getData} from '../../../src/event-helper';
import {getDataParamsFromAttributes} from '../../../src/dom';
import {startsWith} from '../../../src/string';

const MIN_TIMER_INTERVAL_SECONDS = 0.5;
const DEFAULT_MAX_TIMER_LENGTH_SECONDS = 7200;
const VARIABLE_DATA_ATTRIBUTE_KEY = /^vars(.+)/;
const NO_UNLISTEN = function() {};
const TAG = 'analytics-events';

/**
 * @interface
 */
class SignalTrackerDef {
  /**
   * @param {string} unusedEventType
   * @return {!Promise}
   */
  getRootSignal(unusedEventType) {}

  /**
   * @param {string} unusedEventType
   * @param {!Element} unusedElement
   * @return {!Promise}
   */
  getElementSignal(unusedEventType, unusedElement) {}
}

/**
 * The analytics event.
 */
export class AnalyticsEvent {
  /**
   * @param {!Element} target The most relevant target element.
   * @param {string} type The type of event.
   * @param {!Object<string, string>=} opt_vars A map of vars and their values.
   */
  constructor(target, type, opt_vars) {
    /** @const */
    this.target = target;
    /** @const */
    this.type = type;
    /** @const */
    this.vars = opt_vars || Object.create(null);
  }
}


/**
 * The base class for all trackers. A tracker tracks all events of the same
 * type for a single analytics root.
 *
 * @implements {../../../src/service.Disposable}
 * @abstract
 * @visibleForTesting
 */
export class EventTracker {
  /**
   * @param {!./analytics-root.AnalyticsRoot} root
   */
  constructor(root) {
    /** @const */
    this.root = root;
  }

  /** @override @abstract */
  dispose() {}

  /**
   * @param {!Element} unusedContext
   * @param {string} unusedEventType
   * @param {!JsonObject} unusedConfig
   * @param {function(!AnalyticsEvent)} unusedListener
   * @return {!UnlistenDef}
   * @abstract
   */
  add(unusedContext, unusedEventType, unusedConfig, unusedListener) {}
}


/**
 * Tracks custom events.
 */
export class CustomEventTracker extends EventTracker {
  /**
   * @param {!./analytics-root.AnalyticsRoot} root
   */
  constructor(root) {
    super(root);

    /** @const @private {!Object<string, !Observable<!AnalyticsEvent>>} */
    this.observables_ = {};

    /**
     * Early events have to be buffered because there's no way to predict
     * how fast all `amp-analytics` elements will be instrumented.
     * @private {!Object<string, !Array<!AnalyticsEvent>>|undefined}
     */
    this.buffer_ = {};

    /**
     * Sandbox events get their own buffer, because handler to those events will
     * be added after parent element's layout. (Time varies, can be later than 10s)
     * sandbox events buffer will never expire but will cleared when handler is ready.
     * @private {!Object<string, !Array<!AnalyticsEvent>|undefined>|undefined}
     */
    this.sandboxBuffer_ = {};

    // Stop buffering of custom events after 10 seconds. Assumption is that all
    // `amp-analytics` elements will have been instrumented by this time.
    setTimeout(() => {
      this.buffer_ = undefined;
    }, 10000);
  }

  /** @override */
  dispose() {
    this.buffer_ = undefined;
    this.sandboxBuffer_ = undefined;
    for (const k in this.observables_) {
      this.observables_[k].removeAll();
    }
  }

  /** @override */
  add(context, eventType, config, listener) {
    let selector = config['selector'];
    if (!selector) {
      selector = ':root';
    }
    const selectionMethod = config['selectionMethod'] || null;

    const targetReady =
        this.root.getElement(context, selector, selectionMethod);

    const isSandboxEvent = startsWith(eventType, 'sandbox-');

    // Push recent events if any.
    const buffer = isSandboxEvent ?
        this.sandboxBuffer_ && this.sandboxBuffer_[eventType] :
        this.buffer_ && this.buffer_[eventType];

    if (buffer) {
      const bufferLength = buffer.length;
      targetReady.then(target => {
        setTimeout(() => {
          for (let i = 0; i < bufferLength; i++) {
            const event = buffer[i];
            if (target.contains(event.target)) {
              listener(event);
            }
          }
          if (isSandboxEvent) {
            // We assume sandbox event will only has single listener.
            // It is safe to clear buffer once handler is ready.
            this.sandboxBuffer_[eventType] = undefined;
          }
        }, 1);
      });
    }

    let observables = this.observables_[eventType];
    if (!observables) {
      observables = new Observable();
      this.observables_[eventType] = observables;
    }

    return this.observables_[eventType].add(event => {
      // Wait for target selected
      targetReady.then(target => {
        if (target.contains(event.target)) {
          listener(event);
        }
      });
    });
  }

  /**
   * Triggers a custom event for the associated root.
   * @param {!AnalyticsEvent} event
   */
  trigger(event) {
    const eventType = event.type;
    const isSandboxEvent = startsWith(eventType, 'sandbox-');
    const observables = this.observables_[eventType];

    // If listeners already present - trigger right away.
    if (observables) {
      observables.fire(event);
      if (isSandboxEvent) {
        // No need to buffer sandbox event if handler ready
        return;
      }
    }

    // Create buffer and enqueue buffer if needed
    if (isSandboxEvent) {
      this.sandboxBuffer_[eventType] = this.sandboxBuffer_[eventType] || [];
      this.sandboxBuffer_[eventType].push(event);
    } else {
      // Check if buffer has expired
      if (this.buffer_) {
        this.buffer_[eventType] = this.buffer_[eventType] || [];
        this.buffer_[eventType].push(event);
      }
    }
  }
}


/**
 * Tracks click events.
 */
export class ClickEventTracker extends EventTracker {
  /**
   * @param {!./analytics-root.AnalyticsRoot} root
   */
  constructor(root) {
    super(root);

    /** @private {!Observable<!Event>} */
    this.clickObservable_ = new Observable();

    /** @private @const */
    this.boundOnClick_ = e => {
      this.clickObservable_.fire(e);
    };
    this.root.getRoot().addEventListener('click', this.boundOnClick_);
  }

  /** @override */
  dispose() {
    this.root.getRoot().removeEventListener('click', this.boundOnClick_);
    this.clickObservable_.removeAll();
  }

  /** @override */
  add(context, eventType, config, listener) {
    const selector = user().assert(config['selector'],
        'Missing required selector on click trigger');
    const selectionMethod = config['selectionMethod'] || null;
    return this.clickObservable_.add(this.root.createSelectiveListener(
        this.handleClick_.bind(this, listener),
        (context.parentElement || context),
        selector,
        selectionMethod));
  }

  /**
   * @param {function(!AnalyticsEvent)} listener
   * @param {!Element} target
   * @param {!Event} unusedEvent
   * @private
   */
  handleClick_(listener, target, unusedEvent) {
    const params = getDataParamsFromAttributes(
        target,
        /* computeParamNameFunc */ undefined,
        VARIABLE_DATA_ATTRIBUTE_KEY);
    listener(new AnalyticsEvent(target, 'click', params));
  }
}


/**
 * Tracks events based on signals.
 * @implements {SignalTrackerDef}
 */
export class SignalTracker extends EventTracker {
  /**
   * @param {!./analytics-root.AnalyticsRoot} root
   */
  constructor(root) {
    super(root);
  }

  /** @override */
  dispose() {
  }

  /** @override */
  add(context, eventType, config, listener) {
    let target;
    let signalsPromise;
    const selector = config['selector'] || ':root';
    if (selector == ':root' || selector == ':host') {
      // Root selectors are delegated to analytics roots.
      target = this.root.getRootElement();
      signalsPromise = this.getRootSignal(eventType);
    } else {
      // Look for the AMP-element. Wait for DOM to be fully parsed to avoid
      // false missed searches.
      const selectionMethod = config['selectionMethod'];
      signalsPromise = this.root.getAmpElement(
          (context.parentElement || context),
          selector,
          selectionMethod
          ).then(element => {
            target = element;
            return this.getElementSignal(eventType, target);
          });
    }

    // Wait for the target and the event signal.
    signalsPromise.then(() => {
      listener(new AnalyticsEvent(target, eventType));
    });
    return NO_UNLISTEN;
  }

  /** @override */
  getRootSignal(eventType) {
    return this.root.signals().whenSignal(eventType);
  }

  /** @override */
  getElementSignal(eventType, element) {
    if (typeof element.signals != 'function') {
      return Promise.resolve();
    }
    return element.signals().whenSignal(eventType);
  }
}

/**
 * Tracks when the elements in the first viewport has been loaded - "ini-load".
 * @implements {SignalTrackerDef}
 */
export class IniLoadTracker extends EventTracker {
  /**
   * @param {!./analytics-root.AnalyticsRoot} root
   */
  constructor(root) {
    super(root);
  }

  /** @override */
  dispose() {
  }

  /** @override */
  add(context, eventType, config, listener) {
    let target;
    let promise;
    const selector = config['selector'] || ':root';
    if (selector == ':root' || selector == ':host') {
      // Root selectors are delegated to analytics roots.
      target = this.root.getRootElement();
      promise = this.getRootSignal();
    } else {
      // An AMP-element. Wait for DOM to be fully parsed to avoid
      // false missed searches.
      const selectionMethod = config['selectionMethod'];
      promise = this.root.getAmpElement(
          (context.parentElement || context),
          selector,
          selectionMethod
          ).then(element => {
            target = element;
            return this.getElementSignal('ini-load', target);
          });
    }
    // Wait for the target and the event.
    promise.then(() => {
      listener(new AnalyticsEvent(target, eventType));
    });
    return NO_UNLISTEN;
  }

  /** @override */
  getRootSignal() {
    return this.root.whenIniLoaded();
  }

  /** @override */
  getElementSignal(unusedEventType, element) {
    if (typeof element.signals != 'function') {
      return Promise.resolve();
    }
    const signals = element.signals();
    return Promise.race([
      signals.whenSignal(CommonSignals.INI_LOAD),
      signals.whenSignal(CommonSignals.LOAD_END),
    ]);
  }
}


/**
 * Timer event handler.
 */
class TimerEventHandler {
  /**
   * @param {number} intervalLength The length in seconds between pings.
   * @param {number} maxTimerLength The maximum time a timer can run if it does
   *     not have a stopSpec configured.
   * @param {boolean} isUnstoppable Whether this has no stopSpec.
   * @param {boolean} callImmediate Whether to fire this timer immediately upon
   *     starting.
   * @param {function(): UnlistenDef=} startBuilder Factory for building start
   *     trackers for this timer.
   * @param {function(): UnlistenDef=} stopBuilder Factory for building stop
   *     trackers for this timer.
   */
  constructor(intervalLength, maxTimerLength, isUnstoppable, callImmediate,
      startBuilder, stopBuilder) {
    /** @private {number|undefined} */
    this.intervalId_ = undefined;

    /** @const @private {number} */
    this.intervalLength_ = intervalLength;

    /** @const @private {number} */
    this.maxTimerLength_ = maxTimerLength;

    /** @const @private {boolean} */
    this.isUnstoppable_ = isUnstoppable;

    /** @const @private {boolean} */
    this.callImmediate_ = callImmediate;

    /** @private {?UnlistenDef} */
    this.unlistenStart_ = null;

    /** @private {?UnlistenDef} */
    this.unlistenStop_ = null;

    /** @const @private {function(): UnlistenDef|undefined} */
    this.startBuilder_ = startBuilder;

    /** @const @private {function(): UnlistenDef|undefined} */
    this.stopBuilder_ = stopBuilder;
  }

  /** @return {boolean} */
  fireOnTimerStart() {
    return this.callImmediate_;
  }

  /** @return {boolean} */
  canListenForStart() {
    return !!this.startBuilder_;
  }

  /** @return {boolean} */
  isListeningForStart() {
    return !!this.unlistenStart_;
  }

  listenForStart() {
    dev().assert(this.canListenForStart(), 'Cannot listen for timer start.');
    this.unlistenStart_ = this.startBuilder_();
  }

  unlistenForStart() {
    if (this.isListeningForStart()) {
      this.unlistenStart_();
      this.unlistenStart_ = null;
    }
  }

  /** @return {boolean} */
  canListenForStop() {
    return !!this.stopBuilder_;
  }

  /** @return {boolean} */
  isListeningForStop() {
    return !!this.unlistenStop_;
  }

  listenForStop() {
    dev().assert(this.canListenForStop(), 'Cannot listen for timer stop.');
    this.unlistenStop_ = this.stopBuilder_();
  }

  unlistenForStop() {
    if (this.isListeningForStop()) {
      this.unlistenStop_();
      this.unlistenStop_ = null;
    }
  }

  /** @return {boolean} */
  isRunning() {
    return !!this.intervalId_;
  }

  /**
   * @param {!Window} win
   * @param {function()} timerCallback
   * @param {function()} timeoutCallback
   */
  startIntervalInWindow(win, timerCallback, timeoutCallback) {
    this.intervalId_ = win.setInterval(() => {
      timerCallback();
    }, this.intervalLength_ * 1000);

    // If there's no way to turn off the timer, cap it.
    if (this.isUnstoppable_) {
      win.setTimeout(() => {
        timeoutCallback();
      }, this.maxTimerLength_ * 1000);
    }
  }

  /**
   * @param {!Window} win
   */
  clearInterval(win) {
    win.clearInterval(this.intervalId_);
    this.intervalId_ = undefined;
  }
}


/**
 * Tracks timer events.
 */
export class TimerEventTracker extends EventTracker {
  /**
   * @param {!./analytics-root.AnalyticsRoot} root
   */
  constructor(root) {
    super(root);
    /** @const @private {!Object<number, TimerEventHandler>} */
    this.trackers_ = {};

    /** @private {number} */
    this.timerIdSequence_ = 1;
  }

  /**
   * @return {!Array<number>}
   * @visibleForTesting
   */
  getTrackedTimerKeys() {
    return /** @type {!Array<number>} */ (Object.keys(this.trackers_));
  }

  /** @override */
  dispose() {
    this.getTrackedTimerKeys().forEach(timerId => {
      this.removeTracker_(timerId);
    });
  }

  /** @override */
  add(context, eventType, config, listener) {
    const timerSpec = config['timerSpec'];
    user().assert(timerSpec && typeof timerSpec == 'object',
        'Bad timer specification');
    user().assert('interval' in timerSpec,
        'Timer interval specification required');
    const interval = Number(timerSpec['interval']) || 0;
    user().assert(interval >= MIN_TIMER_INTERVAL_SECONDS,
        'Bad timer interval specification');
    const maxTimerLength = 'maxTimerLength' in timerSpec ?
        Number(timerSpec['maxTimerLength']) : DEFAULT_MAX_TIMER_LENGTH_SECONDS;
    user().assert(maxTimerLength == null || maxTimerLength > 0,
        'Bad maxTimerLength specification');
    const callImmediate = 'immediate' in timerSpec ?
        Boolean(timerSpec['immediate']) : true;
    const timerStart = 'startSpec' in timerSpec ? timerSpec['startSpec'] : null;
    user().assert(!timerStart || typeof timerStart == 'object',
        'Bad timer start specification');
    const timerStop = 'stopSpec' in timerSpec ? timerSpec['stopSpec'] : null;
    user().assert((!timerStart && !timerStop) || typeof timerStop == 'object',
        'Bad timer stop specification');

    const timerId = this.generateTimerId_();
    const isUnstoppableTimer = !timerStop;
    let startBuilder;
    let stopBuilder;
    if (!!timerStart) {
      const startTracker = this.getTracker(timerStart);
      user().assert(startTracker, 'Cannot track timer start');
      startBuilder = startTracker.add.bind(startTracker, context,
          timerStart['on'], timerStart,
          this.handleTimerToggle_.bind(this, timerId, eventType, listener));
    }
    if (!isUnstoppableTimer) {
      const stopTracker = this.getTracker(timerStop);
      user().assert(stopTracker, 'Cannot tracker timer stop');
      stopBuilder = stopTracker.add.bind(stopTracker, context,
          timerStop['on'], timerStop,
          this.handleTimerToggle_.bind(this, timerId, eventType, listener));
    }

    const timerHandler = new TimerEventHandler(interval, maxTimerLength,
        isUnstoppableTimer, callImmediate, startBuilder, stopBuilder);
    this.trackers_[timerId] = timerHandler;

    if (!timerStart) {
      // Timer starts on load.
      this.startTimer_(timerId, eventType, listener);
    } else {
      // Timer starts on event.
      timerHandler.listenForStart();
    }
    return () => {
      this.removeTracker_(timerId);
    };
  }

  /**
   * @return {number}
   * @private
   */
  generateTimerId_() {
    return ++this.timerIdSequence_;
  }

  /**
   * @param {!JsonObject}
   * @return {?EventTracker}
   */
  getTracker(config) {
    const eventType = user().assertString(config['on']);
    const trackerKey = getTrackerKeyName(eventType);

    return this.root.getTrackerForWhitelist(
        trackerKey, getTrackerTypesForTimerEventTracker());
  }

  /**
   * Toggles which listeners are active depending on timer state, so no race
   * conditions can occur in the case where the timer starts and stops on the
   * same event type from the same target.
   * @param {number} timerId
   * @param {string} eventType
   * @param {function(!AnalyticsEvent)} listener
   * @private
   */
  handleTimerToggle_(timerId, eventType, listener) {
    const timerHandler = this.trackers_[timerId];
    if (timerHandler.isRunning()) {
      // Stop timer and listen for start.
      this.stopTimer_(timerId);
      if (timerHandler.canListenForStart()) {
        timerHandler.listenForStart();
      }
    } else {
      // Start timer and listen for stop.
      this.startTimer_(timerId, eventType, listener);
      if (timerHandler.canListenForStop()) {
        timerHandler.listenForStop();
      }
    }
  }

  /**
   * @param {number} timerId
   * @param {string} eventType
   * @param {function(!AnalyticsEvent)} listener
   * @private
   */
  startTimer_(timerId, eventType, listener) {
    const timerHandler = this.trackers_[timerId];
    if (timerHandler.isRunning()) {
      return;
    }
    const timerCallback = listener.bind(this, this.createEvent_(eventType));
    timerHandler.startIntervalInWindow(this.root.ampdoc.win, timerCallback,
        this.removeTracker_.bind(this, timerId));
    timerHandler.unlistenForStart();
    if (timerHandler.fireOnTimerStart()) {
      timerCallback();
    }
  }

  /**
   * @param {number} timerId
   * @private
   */
  stopTimer_(timerId) {
    const timerHandler = this.trackers_[timerId];
    if (!timerHandler.isRunning()) {
      return;
    }
    timerHandler.clearInterval(this.root.ampdoc.win);
    timerHandler.unlistenForStop();
  }

  /**
   * @param {string} eventType
   * @return {!AnalyticsEvent}
   * @private
   */
  createEvent_(eventType) {
    return new AnalyticsEvent(this.root.getRootElement(), eventType);
  }

  /**
   * @param {number} timerId
   * @private
   */
  removeTracker_(timerId) {
    if (!!this.trackers_[timerId]) {
      this.stopTimer_(timerId);
      this.trackers_[timerId].unlistenForStart();
      this.trackers_[timerId].unlistenForStop();
      delete this.trackers_[timerId];
    }
  }
}


/**
 * Tracks video session events
 */
export class VideoEventTracker extends EventTracker {
  /**
   * @param {!./analytics-root.AnalyticsRoot} root
   */
  constructor(root) {
    super(root);

    /** @private {?Observable<!Event>} */
    this.sessionObservable_ = new Observable();

    /** @private {?Function} */
    this.boundOnSession_ = e => {
      this.sessionObservable_.fire(e);
    };

    Object.keys(VideoAnalyticsEvents).forEach(key => {
      this.root.getRoot().addEventListener(
          VideoAnalyticsEvents[key], this.boundOnSession_);
    });
  }

  /** @override */
  dispose() {
    const root = this.root.getRoot();
    Object.keys(VideoAnalyticsEvents).forEach(key => {
      root.removeEventListener(VideoAnalyticsEvents[key], this.boundOnSession_);
    });
    this.boundOnSession_ = null;
    this.sessionObservable_ = null;
  }

  /** @override */
  add(context, eventType, config, listener) {
    const videoSpec = config['videoSpec'] || {};
    const selector = config['selector'] || videoSpec['selector'];
    const selectionMethod = config['selectionMethod'] || null;
    const targetReady =
        this.root.getElement(context, selector, selectionMethod);

    const endSessionWhenInvisible = videoSpec['end-session-when-invisible'];
    const excludeAutoplay = videoSpec['exclude-autoplay'];
    const interval = videoSpec['interval'];
    const on = config['on'];

    let intervalCounter = 0;

    return this.sessionObservable_.add(event => {
      const type = event.type;
      const isVisibleType = (type === VideoAnalyticsEvents.SESSION_VISIBLE);
      const normalizedType =
          isVisibleType ? VideoAnalyticsEvents.SESSION : type;
      const details = /** @type {!VideoAnalyticsDetailsDef} */ (getData(event));

      if (normalizedType !== on) {
        return;
      }

      if (normalizedType === VideoAnalyticsEvents.SECONDS_PLAYED && !interval) {
        user().error(TAG, 'video-seconds-played requires interval spec ' +
            'with non-zero value');
        return;
      }

      if (normalizedType === VideoAnalyticsEvents.SECONDS_PLAYED) {
        intervalCounter++;
        if (intervalCounter % interval !== 0) {
          return;
        }
      }

      if (isVisibleType && !endSessionWhenInvisible) {
        return;
      }

      if (excludeAutoplay && details['state'] === PlayingStates.PLAYING_AUTO) {
        return;
      }

      const el = dev().assertElement(event.target,
          'No target specified by video session event.');
      targetReady.then(target => {
        if (target.contains(el)) {
          listener(new AnalyticsEvent(target, normalizedType, details));
        }
      });
    });
  }
}


/**
 * Tracks visibility events.
 */
export class VisibilityTracker extends EventTracker {
  /**
   * @param {!./analytics-root.AnalyticsRoot} root
   */
  constructor(root) {
    super(root);

    /** @private */
    this.waitForTrackers_ = {};
  }

  /** @override */
  dispose() {
  }

  /** @override */
  add(context, eventType, config, listener) {
    const visibilitySpec = config['visibilitySpec'] || {};
    const selector = config['selector'] || visibilitySpec['selector'];
    const waitForSpec = visibilitySpec['waitFor'];
    const visibilityManager = this.root.getVisibilityManager();
    // special polyfill for eventType: 'hidden'
    let createReadyReportPromiseFunc = null;
    if (eventType == 'hidden') {
      createReadyReportPromiseFunc = this.createReportReadyPromise_.bind(this);
    }

    // Root selectors are delegated to analytics roots.
    if (!selector || selector == ':root' || selector == ':host') {
      // When `selector` is specified, we always use "ini-load" signal as
      // a "ready" signal.
      return visibilityManager.listenRoot(
          visibilitySpec,
          this.getReadyPromise(waitForSpec, selector),
          createReadyReportPromiseFunc,
          this.onEvent_.bind(
              this, eventType, listener, this.root.getRootElement()));
    }

    // An AMP-element. Wait for DOM to be fully parsed to avoid
    // false missed searches.
    const selectionMethod = config['selectionMethod'] ||
          visibilitySpec['selectionMethod'];
    const unlistenPromise = this.root.getAmpElement(
        (context.parentElement || context),
        selector,
        selectionMethod
        ).then(element => {
          return visibilityManager.listenElement(
              element,
              visibilitySpec,
              this.getReadyPromise(waitForSpec, selector, element),
              createReadyReportPromiseFunc,
              this.onEvent_.bind(this, eventType, listener, element));
        });
    return function() {
      unlistenPromise.then(unlisten => {
        unlisten();
      });
    };
  }

  /**
   * @return {!Promise}
   * @visibleForTesting
   */
  createReportReadyPromise_() {
    const viewer = this.root.getViewer();

    if (!viewer.isVisible()) {
      return Promise.resolve();
    }

    return new Promise(resolve => {
      viewer.onVisibilityChanged(() => {
        if (!viewer.isVisible()) {
          resolve();
        }
      });
    });
  }

  /**
   * @param {string|undefined} waitForSpec
   * @param {string|undefined} selector
   * @param {Element=} element
   * @return {?Promise}
   * @visibleForTesting
   */
  getReadyPromise(waitForSpec, selector, element) {
    if (!waitForSpec) {
      // Default case:
      if (!selector) {
        // waitFor selector is not defined, wait for nothing
        return null;
      } else {
        // otherwise wait for ini-load by default
        waitForSpec = 'ini-load';
      }
    }

    const trackerWhitelist = getTrackerTypesForVisibilityTracker();
    user().assert(waitForSpec == 'none' ||
        trackerWhitelist[waitForSpec] !== undefined,
        'waitFor value %s not supported', waitForSpec);

    const waitForTracker = this.waitForTrackers_[waitForSpec] ||
        this.root.getTrackerForWhitelist(waitForSpec, trackerWhitelist);
    if (waitForTracker) {
      this.waitForTrackers_[waitForSpec] = waitForTracker;
    } else {
      return null;
    }

    // Wait for root signal if there's no element selected.
    return element ? waitForTracker.getElementSignal(waitForSpec, element)
        : waitForTracker.getRootSignal(waitForSpec);
  }

  /**
   * @param {string} eventType
   * @param {function(!AnalyticsEvent)} listener
   * @param {!Element} target
   * @param {!Object<string, *>} state
   * @private
   */
  onEvent_(eventType, listener, target, state) {
    const attr = getDataParamsFromAttributes(
        target,
        /* computeParamNameFunc */ undefined,
        VARIABLE_DATA_ATTRIBUTE_KEY);
    for (const key in attr) {
      state[key] = attr[key];
    }
    listener(new AnalyticsEvent(target, eventType, state));
  }
}
