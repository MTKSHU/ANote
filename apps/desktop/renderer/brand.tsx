import React from 'react';
import './brand.css';

const logo = new URL('./assets/anote-logo.png', import.meta.url).href;

export function BrandLogo({size=32}:{size?:number}) {
  return <img className="anote-logo" src={logo} width={size} height={size} alt="" aria-hidden="true" draggable={false}/>;
}
