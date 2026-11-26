import React from 'react';

const paths=[
 ['M10 48 38 41 63 44 89 25 115 30 141 16 170 22','M180 10V54M190 32H244','M202 21H233V43H202Z'],
 ['M12 54C39 54 44 15 78 15S115 54 144 54 184 10 211 10 229 35 248 35','M12 44C39 44 54 29 78 29S115 44 144 44 184 24 211 24 229 30 248 30'],
 ['M12 14H65L120 34H174','M12 34H174','M12 54H65L120 34','M174 34H246','M200 25 209 34 200 43'],
 ['M12 15H44V21H76V28H108V34H140V43H172V48H204V55H246','M12 65V60M44 65V60M76 65V60M108 65V60M140 65V60M172 65V60M204 65V60M246 65V60'],
 ['M12 56H69L137 15H246','M69 65V7M137 65V7','M155 55V31H218V55ZM166 31V24C166 10 207 10 207 24V31'],
 ['M16 56V43H74V56M45 43V28H132V43M103 56V43H161V56M132 28V12H219V28M190 56V43H248V56M219 43V28'],
];
export default function MechanismDiagram({index}){return <svg className="mechanism-diagram" viewBox="0 0 260 76" fill="none" aria-hidden="true" focusable="false"><path className="mechanism-baseline" d="M4 68H256"/>{paths[index].map((d,i)=><path key={i} className={`mechanism-trace trace-${i}`} d={d} pathLength="100"/>)}<circle className="mechanism-node" cx={index===5?132:index===2?174:246} cy={index===5?12:index===2?34:index===0?32:index===1?35:index===3?55:15} r="3"/></svg>}
