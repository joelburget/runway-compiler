"use strict";

let jQuery = require('jquery');
window.jQuery = jQuery;

require('bootstrap-webpack');
let BootstrapMenu = require('bootstrap-menu');

let compiler = require('./compiler.js');
window.compiler = compiler;
let Simulator = require('./simulator.js').Simulator;
let GlobalEnvironment = require('./environment.js').GlobalEnvironment;
let Input = require('./input.js');

let _ = require('lodash');
//delete window._;

let errors = require('./errors.js');
let Tooltip = require('./web/tooltip.js');
let Util = require('./web/util.js');
let StateDump = require('./web/statedump.jsx');
let RuleControls = require('./web/rulecontrols.jsx');
let ExecutionView = require('./web/executionview.jsx');
let REPLView = require('./web/repl.jsx');
let Controller = require('./controller.js');

let preludeText = require('./prelude.model');

let queryString = require('querystring');
let getParams = queryString.parse(window.location.search.slice(1));

let React = require('react');
let ReactDOM = require('react-dom');

let babel = require('babel-standalone');

let useClock = getParams['clock'] && true;

let prelude = compiler.loadPrelude(preludeText, {
  clock: useClock,
});

let meval = (text) => {
  let env = new GlobalEnvironment(prelude.env);
  let module = compiler.load(new Input('eval', text), env);
  let context = {
    clock: 0,
  };
  module.ast.execute(context);
};
window.meval = meval;

let fetchRemoteFile = (filename) => new Promise((resolve, reject) => {
    jQuery.ajax(filename, {
      dataType: 'text',
    }).done(text => {
      resolve(new Input(filename, text));
    }).fail((req, st, err) => {
      reject(err);
    });
  });

// exported to modules loaded at runtime
let requireModules = {
  'bootstrap-menu': BootstrapMenu,
  jquery: jQuery,
  React: React,
  ReactDOM: ReactDOM,
  StateDump: StateDump,
  Tooltip: Tooltip,
  Util: Util,
  fetchRemoteFile: fetchRemoteFile,
  Changesets: require('./changesets.js'),
  lodash: _,
  Timeline: require('./web/timeline.jsx'),
};
let pseudoRequire = function(module) {
  if (module in requireModules) {
    return requireModules[module];
  } else {
    throw Error(`Unknown module: ${module}`);
  }
};

let fetchRemoteModule = function(filename) {
  return fetchRemoteFile(filename)
    .then((input) => {
      let load = new Function('module', 'require', input.getText());
      let module = {};
      load(module, pseudoRequire);
      return module.exports;
    });
};

let fetchRemoteJSX = function(filename) {
  return fetchRemoteFile(filename)
    .then((input) => {
      let code = babel.transform(input.getText(), {
        presets: ['react'],
      }).code;
      let load = new Function('module', 'require', code);
      let module = {};
      load(module, pseudoRequire);
      return module.exports;
    });
};

class TextStateView {
  constructor(controller, elem, module) {
    this.name = 'TextStateView';
    this.controller = controller;
    this.elem = elem;
    this.module = module;
    this.update();
  }

  update() {
    let output = Array.from(this.module.env.vars.list())
      .map(k => [k, this.module.env.vars.get(k)])
      .filter(kv => kv[1].isConstant !== true)
      .map(kv => `${kv[0]}: ${kv[1]}`)
      .join('\n');
    this.elem.text(output);
  }
}

class HTMLStateView {
  constructor(controller, elem, module) {
    this.name = 'HTMLStateView';
    this.controller = controller;
    this.elem = elem;
    this.module = module;
    this.component = ReactDOM.render(
      React.createElement(
        StateDump.StateDumpEnv,
        {
          env: this.module.env,
          controller: this.controller,
        }),
      this.elem[0]);
  }

  update(changes) {
    this.component.setState({changes: changes});
  }
}

let pageLoaded = new Promise((resolve, reject) => {
  jQuery(window).load(resolve);
});


let basename = 'examples/toomanybananas/toomanybananas';
if ('model' in getParams) {
  basename = 'examples/' + getParams['model'];
}

Promise.all([
  fetchRemoteFile(basename + '.model'),
  fetchRemoteJSX(basename + '.jsx')
    .catch(err => {
      console.log(`Failed to get view file over HTTP: ${err}`);
      return null;
    }),
  pageLoaded,
]).then((results) => {
  let input = results[0];
  let env = new GlobalEnvironment(prelude.env);
  let module;
  try {
    module = compiler.load(input, env);
    window.module = module;
    let context = {
      clock: 0,
    };
    module.ast.execute(context);
  } catch ( e ) {
    jQuery('#error').text(e);
    throw e;
  }
  let controller = new Controller(module);
  controller.errorHandler = (msg, e) => {
    console.log(msg);
    jQuery('#error').text(msg);
    throw e;
  };
  controller.resetHandler = () => {
    jQuery('#error').text('');
  };
  window.controller = controller;
  controller.views.push(
    new HTMLStateView(controller, jQuery('#state'), module));
  controller.views.push(
    new RuleControls(controller, jQuery('#rulecontrols')[0], module));
  controller.views.push(
    new ExecutionView(controller, jQuery('#execution')[0], module));
  controller.views.push(
    new REPLView(controller, jQuery('#repl')[0], module));

  let userView = results[1];
  if (userView !== null) {
    userView = new userView(controller, jQuery('#view #user')[0], module);
    let use = v => {
      if (v.name === undefined) {
        v.name = 'User';
      }
      controller.views.push(v);
    };
    if (userView instanceof Promise) {
      userView.then(use);
    } else {
      use(userView);
    }
  }

  let animate = false;
  let animating = false;
  let simulateId = undefined;
  let simulateStart = 0;

  // 'simulateSpeed' is number of wall microseconds per simulated clock tick
  // (or equivalently, the "x" of slowdown).
  // For asynchronous models without clocks, it's the number of wall
  // microseconds per step.
  window.simulateSpeed = 500000;
  if (useClock) {
    window.simulateSpeed = 100;
  }
  let simulator = new Simulator(module, controller);
  let doStep = () => {
    try {
      simulator.step();
    } catch (e) {
      jQuery('#simulate').prop('checked', false);
      throw e;
    }
  };
  let toggleTimeout = () => {
    let stop = () => {
      window.clearTimeout(simulateId);
      simulateId = undefined;
    };
    if (simulateId === undefined) {
      let step = () => {
        simulateId = undefined;
        doStep();
        simulateId = setTimeout(step, window.simulateSpeed / 1000);
      };
      step();
    } else {
      stop();
    }
  };
  let toggleAnimate = () => {
    let stop = () => {
      window.cancelAnimationFrame(simulateId);
      simulateId = undefined;
    };
    if (simulateId === undefined) {
      let step = when => {
        simulateId = undefined;
        let elapsed = (when - simulateStart);
        simulateStart = when;
        //console.log('elapsed:', elapsed, 'ms');
        if (elapsed > 500) { // probably had another tab open
          console.log(`Too much time elapsed between animation ` +
            `frames: ${elapsed} ms`);
          elapsed = 0;
        }
        controller.advanceClock(elapsed * 1000 / window.simulateSpeed);
        doStep();
        simulateId = window.requestAnimationFrame(step);
      };
      step(simulateStart);
    } else {
      stop();
    }
  };
  if (useClock) {
    jQuery('#simulate').change(toggleAnimate);
  } else {
    jQuery('#simulate').change(toggleTimeout);
  }
  let mapSimulateSpeed = fn => {
    window.simulateSpeed = _.clamp(fn(window.simulateSpeed), .1, 5000000);
    console.log(window.simulateSpeed);
  };
  jQuery('#slower').click(() => mapSimulateSpeed(s => s * 2));
  jQuery('#faster').click(() => mapSimulateSpeed(s => s / 2));


  let viewWrapper = jQuery('#viewwrapper');
  let viewElem = jQuery('#view');
  let smallSide = 100;
  controller.views.forEach(v => {
    if (v.bigView) {
      smallSide = 1000;
    }
  });
  viewWrapper.mouseup(() => {
    let width = viewWrapper.width();
    let height = viewWrapper.height();
    console.log(`resize to ${width}, ${height}`);
    viewElem.width(width);
    viewElem.height(height);
    if (width < height) {
      height = height / width * smallSide;
      width = smallSide;
    } else {
      width = width / height * smallSide;
      height = smallSide;
    }
    // viewElem.attr('viewBox', ...) sets viewbox (lowercase) instead
    viewElem[0].setAttribute('viewBox',
      `0 0 ${width} ${height}`);
    controller.updateViews();
  });
});
