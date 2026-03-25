const DEFS = [
  {id:'140L',  name:'140L',       sap:'B-0140',  W:480,  D:560,  H:1070, type:'bin',             wheels:2},
  {id:'240L',  name:'240L',       sap:'B-0240',  W:580,  D:740,  H:1070, type:'bin',             wheels:2},
  {id:'360L',  name:'360L',       sap:'B-0360',  W:625,  D:850,  H:1100, type:'bin',             wheels:2},
  {id:'660L',  name:'660L',       sap:'B-0660',  W:1360, D:770,  H:1180, type:'bin-large',       wheels:4},
  {id:'1000L', name:'1000L',      sap:'B-1000',  W:1320, D:1080, H:1320, type:'bin-xl',          wheels:4},
  {id:'BALEX',   name:'Balex 20',    sap:'', W:1840, D:1100, H:1950, type:'compactor', wheels:0},
  {id:'BALEX10', name:'Balex 10',    sap:'', W:1360, D:840,  H:1920, type:'compactor', wheels:0},
  {id:'BUR',   name:'Bur',        sap:'B-0B-E',  W:1600, D:1200, H:1200, type:'cage',            wheels:4},
  // type:'machine' — GLB with baked textures; materials are NOT replaced in buildContainer
  {id:'ORWAK5070',   name:'Orwak Multi 5070',  sap:'', W:1740, D:880, H:2160, type:'machine', wheels:0},
  // glbModelRotY: GLB has physical width (2550mm) along local Z, depth (920mm) along local X.
  // Pre-rotating π/2 inside loadGLB aligns axes so bounding box gives size.x=2550, size.z=920
  // → scale.x=1, scale.z=1 (no distortion). Standard wrapper rotation handles placement.
  {id:'OW5070COMBI', name:'OW5070 Combi',       sap:'', W:2550, D:920, H:2265, type:'machine', wheels:0, glbModelRotY: Math.PI/2},
  {id:'ENVIROPAC',   name:'EnviroPac Kjøler',   sap:'', W:965,  D:853, H:1475, type:'machine', wheels:0},
];

const WALL_EL_DEFS = {
  'door':        {name:'Dør',         W:900,  D:100, type:'door',   swingR:900},
  'door-double': {name:'Dobbeldør',   W:1800, D:100, type:'door',   swingR:900, double:true},
  'window':      {name:'Vindu',       W:1200, D:200, type:'window'},
  'pillar':      {name:'Søyle',       W:300,  D:300, type:'pillar'},
  'exit':        {name:'Rømningsvei', W:600,  D:600, type:'exit'},
};

// ── Fraksjon-definisjoner ────────────────────────────────────────────────
const FRAKSJONER = [
  { id: 'rest',       label: 'Restavfall',                color: '#2e2e2e', lidColor: '#1a1a1a', textColor: '#fff' },
  { id: 'mat',        label: 'Matavfall',                 color: '#4caf50', lidColor: '#2e7d32', textColor: '#fff' },
  { id: 'papir',      label: 'Papp og Papir',             color: '#1565c0', lidColor: '#0d47a1', textColor: '#fff' },
  { id: 'papp',       label: 'Papp',                      color: '#1976d2', lidColor: '#0d47a1', textColor: '#fff' },
  { id: 'plast',      label: 'Plastemballasje',           color: '#8e24aa', lidColor: '#6a1b9a', textColor: '#fff' },
  { id: 'plastfolie', label: 'Plastfolie',                color: '#7b1fa2', lidColor: '#4a148c', textColor: '#fff' },
  { id: 'glass',      label: 'Glass og metallemballasje', color: '#5a7a5e', lidColor: '#3d5940', textColor: '#fff' },
  { id: 'metall',     label: 'Metall',                    color: '#546e7a', lidColor: '#37474f', textColor: '#fff' },
  { id: 'eps',        label: 'EPS',                       color: '#e0e0e0', lidColor: '#bdbdbd', textColor: '#222' },
  { id: 'farlig',     label: 'Farlig avfall',             color: '#b71c1c', lidColor: '#7f0000', textColor: '#fff' },
  { id: 'ee',         label: 'EE-avfall',                 color: '#4a148c', lidColor: '#311b92', textColor: '#fff' },
];

function getFraksjon(id) {
  return FRAKSJONER.find(f => f.id === id) || FRAKSJONER[0];
}

// ── Sorteringsmerker ────────────────────────────────────────────────────────
// Offisielle sortere.no PNG-ikoner lastet fra Cloudflare R2
const R2 = 'https://pub-27fd45166dba4be8a488b48df57742df.r2.dev';
const SKILT_DEFS = [
  { id: 'sk-rest',       name: 'Restavfall',                url: `${R2}/Restavfall_web.png`,             iconUrl: `${R2}/Restavfall_web.png`             },
  { id: 'sk-mat',        name: 'Matavfall',                 url: `${R2}/Matavfall_web.png`,              iconUrl: `${R2}/Matavfall_web.png`              },
  { id: 'sk-glass',      name: 'Glass og metallemballasje', url: `${R2}/Glass_metallemballasje_web.png`,  iconUrl: `${R2}/Glass_metallemballasje_web.png`  },
  { id: 'sk-papir',      name: 'Papp og Papir',             url: `${R2}/Papp_og_papir_web.png`,          iconUrl: `${R2}/Papp_og_papir_web.png`          },
  { id: 'sk-papp',       name: 'Papp',                      url: `${R2}/Papp_web.png`,                   iconUrl: `${R2}/Papp_web.png`                   },
  { id: 'sk-plast',      name: 'Plastemballasje',           url: `${R2}/Plastemballasje_web.png`,        iconUrl: `${R2}/Plastemballasje_web.png`        },
  { id: 'sk-plastfolie', name: 'Plastfolie',                url: `${R2}/Plastfolie_web.png`,             iconUrl: `${R2}/Plastfolie_web.png`             },
  { id: 'sk-metall',     name: 'Metall',                    url: `${R2}/Jern_og_metaller_web.png`,       iconUrl: `${R2}/Jern_og_metaller_web.png`       },
  { id: 'sk-eps',        name: 'EPS',                       url: `${R2}/EPS_web.png`,                    iconUrl: `${R2}/EPS_web.png`                    },
  { id: 'sk-farlig',     name: 'Farlig avfall',             url: `${R2}/Farlig_avfall_web.png`,          iconUrl: `${R2}/Farlig_avfall_web.png`          },
  { id: 'sk-ee',         name: 'EE-avfall',                 url: `${R2}/Elektronikk_web.png`,            iconUrl: `${R2}/Elektronikk_web.png`            },
];

const NG_ORANGE = '#E8521A';
const BIN_BODY  = '#3c3c3c';
