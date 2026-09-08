// scratch-gui 的 UMD 产物把 react / react-dom 作为外部依赖，
// 在浏览器全局分支里读的是小写的 window.react 和 window['react-dom']。
window.react = window.React;
window['react-dom'] = window.ReactDOM;
