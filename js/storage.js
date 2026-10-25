import { initialState, seedBooks } from './data.js';
const KEY='neo-world-library-v1';
export function loadState(){try{const raw=localStorage.getItem(KEY);const base=initialState();if(!raw)return {...base,books:seedBooks.map(b=>({...b}))};const saved=JSON.parse(raw);if(!saved||saved.version!==1)return {...base,books:seedBooks.map(b=>({...b}))};return {...base,...saved,books:seedBooks.map(b=>({...b}))};}catch(err){console.warn('Starting fresh demo state',err);return {...initialState(),books:seedBooks.map(b=>({...b}))};}}
export function saveState(state){try{const {books,...persisted}=state;localStorage.setItem(KEY,JSON.stringify(persisted));return true;}catch(err){console.warn('Could not save app state',err);return false;}}
export function resetState(){try{localStorage.removeItem(KEY);}catch(err){console.warn(err);}return {...initialState(),books:seedBooks.map(b=>({...b}))};}
