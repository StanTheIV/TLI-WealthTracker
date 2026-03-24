export interface Theme {
  background:      string;
  surface:         string;
  surfaceElevated: string;
  accent:          string;
  accentMuted:     string;
  gold:            string;
  goldMuted:       string;
  textPrimary:     string;
  textSecondary:   string;
  textDisabled:    string;
  border:          string;
  navActive:       string;
  buttonText:      string;
  danger:          string;
  success:         string;
}

// Prussian-blue base + tech-blue accent + sunflower-gold highlight
export const darkTheme: Theme = {
  background:      '#05050e',
  surface:         '#0a0a1c',
  surfaceElevated: '#111128',
  accent:          '#2878d4',
  accentMuted:     '#0d4a96',
  gold:            '#F9B31E',
  goldMuted:       '#7a4800',
  textPrimary:     '#dde4f0',
  textSecondary:   '#7a8aaa',
  textDisabled:    '#3e4560',
  border:          '#181838',
  navActive:       'rgba(40,120,212,0.18)',
  buttonText:      '#ffffff',
  danger:          '#d94f4f',
  success:         '#3dbf7a',
};

// Warm parchment + tech-blue accent + amber gold
export const lightTheme: Theme = {
  background:      '#f5f0e8',
  surface:         '#fffdf7',
  surfaceElevated: '#ede8d8',
  accent:          '#095FBE',
  accentMuted:     '#4a88d4',
  gold:            '#c07000',
  goldMuted:       '#d4900a',
  textPrimary:     '#060626',
  textSecondary:   '#3a3060',
  textDisabled:    '#9090b8',
  border:          '#c8c0e0',
  navActive:       'rgba(9,95,190,0.12)',
  buttonText:      '#ffffff',
  danger:          '#b83030',
  success:         '#2a9a5e',
};
