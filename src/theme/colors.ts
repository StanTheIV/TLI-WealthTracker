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

// Deep navy + cobalt blue accent + amber gold highlight
export const darkTheme: Theme = {
  background:      '#0d1117',
  surface:         '#151c28',
  surfaceElevated: '#1e2a3d',
  accent:          '#2e6fd4',
  accentMuted:     '#1a4a9a',
  gold:            '#f0a020',
  goldMuted:       '#8a5a10',
  textPrimary:     '#e8edf5',
  textSecondary:   '#8090aa',
  textDisabled:    '#3a4560',
  border:          '#1e2d45',
  navActive:       'rgba(46,111,212,0.15)',
  buttonText:      '#ffffff',
  danger:          '#d94f4f',
  success:         '#3dbf7a',
};

// Warm off-white + same cobalt + amber
export const lightTheme: Theme = {
  background:      '#f0f2f7',
  surface:         '#ffffff',
  surfaceElevated: '#e4e8f2',
  accent:          '#1d55b0',
  accentMuted:     '#4a7dd4',
  gold:            '#c07810',
  goldMuted:       '#d4a050',
  textPrimary:     '#0d1117',
  textSecondary:   '#4a5870',
  textDisabled:    '#a0aabf',
  border:          '#c8d0e0',
  navActive:       'rgba(29,85,176,0.12)',
  buttonText:      '#ffffff',
  danger:          '#b83030',
  success:         '#2a9a5e',
};
