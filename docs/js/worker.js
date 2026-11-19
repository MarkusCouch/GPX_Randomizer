import {buildNetwork, generateRoutes} from './network.js';
let network = null;
self.onmessage = ({data}) => {
  const {id, type, routes, options} = data;
  const progress = state => self.postMessage({id, type: 'progress', ...state});
  try {
    if (type === 'build') {network = buildNetwork(routes, options, progress); self.postMessage({id, type: 'result', network});}
    else if (type === 'generate') {if (!network) throw new Error('Bitte zuerst das Wegenetz aufbauen.'); self.postMessage({id, type: 'result', result: generateRoutes(network, options, progress)});}
    else throw new Error('Unbekannte Aktion.');
  } catch (error) {self.postMessage({id, type: 'error', message: error.message,code:error.code,details:error.details});}
};
