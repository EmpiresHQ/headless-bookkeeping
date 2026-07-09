import { useQuery } from '@tanstack/react-query';
import {
  getCategories,
  getEntities,
  getExpenses,
  getInvoices,
  getOrganization,
  getReportingPeriods,
} from '../api';
import { sharedKeys } from './keys';

/** Cross-domain read hooks. Role-filtered entity views share ONE cache entry
 *  (same queryKey, different select). */
export const useCategories = () =>
  useQuery({ queryKey: sharedKeys.categories, queryFn: getCategories });

export const useEntities = () =>
  useQuery({ queryKey: sharedKeys.entities, queryFn: getEntities });

export const useSuppliers = () =>
  useQuery({
    queryKey: sharedKeys.entities,
    queryFn: getEntities,
    select: (entities) => entities.filter((e) => e.role === 'supplier'),
  });

export const useCustomers = () =>
  useQuery({
    queryKey: sharedKeys.entities,
    queryFn: getEntities,
    select: (entities) => entities.filter((e) => e.role === 'customer'),
  });

export const useOrganizationCountry = () =>
  useQuery({
    queryKey: sharedKeys.organization,
    queryFn: getOrganization,
    select: (org) => org.country,
  });

export const useExpenses = () =>
  useQuery({ queryKey: sharedKeys.expenses, queryFn: getExpenses });

export const useInvoices = () =>
  useQuery({ queryKey: sharedKeys.invoices, queryFn: getInvoices });

export const useReportingPeriods = () =>
  useQuery({
    queryKey: sharedKeys.reportingPeriods,
    queryFn: getReportingPeriods,
  });
