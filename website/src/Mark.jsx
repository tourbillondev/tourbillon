import React from 'react';
import {markPath,markViewBox} from './mark-path.mjs';
export default function Mark(){return <svg viewBox={markViewBox} fill="none" aria-hidden="true" focusable="false"><path d={markPath} fill="currentColor" fillRule="evenodd"/></svg>}
