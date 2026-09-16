import type { Scenario } from '../types';
import { resnet50Scenario } from './resnet50';
import { swinv2Scenario } from './swinv2';
import { conv3x3Scenario } from './conv3x3';

export { resnet50Scenario, swinv2Scenario, conv3x3Scenario };

export const SCENARIOS: Scenario[] = [
  resnet50Scenario,
  swinv2Scenario,
  conv3x3Scenario,
];

export const scenarioById = (id: string): Scenario | undefined =>
  SCENARIOS.find((s) => s.id === id);
