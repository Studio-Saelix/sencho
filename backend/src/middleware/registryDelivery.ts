import type { Request, Response, NextFunction } from 'express';
import { REGISTRY_DELIVERY_BODY_FIELD } from '../helpers/registryDeliveryBodyLimits';
import type { RegistryDeliveryEnvelope } from '../helpers/registryDeliveryContext';
import { runWithRegistryDeliveryContext } from '../helpers/registryDeliveryContext';
import { classifyRegistryDeliveryOp } from '../helpers/registryOpClassifier';
import { resolveDeliveryStack } from '../helpers/registryDeliveryDiscoverPayload';
import {
  attestationJtiFromToken,
  hashPrepId,
  recordRegistryDeliveryEvent,
} from '../helpers/registryDeliveryEvidence';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';

/** Express strips the /api mount prefix from req.path; classifiers expect /api/... */
export function registryDeliveryApiPath(req: Pick<Request, 'path'>): string {
  return `/api${req.path}`;
}

function scrubDeliveryField(body: unknown): void {
  if (!body || typeof body !== 'object') return;
  if (REGISTRY_DELIVERY_BODY_FIELD in (body as Record<string, unknown>)) {
    delete (body as Record<string, unknown>)[REGISTRY_DELIVERY_BODY_FIELD];
  }
}

/**
 * Capture and verify registry delivery envelopes on classified target routes.
 * Installed after authGate and before remoteNodeProxy.
 */
export function registryDeliveryMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiPath = registryDeliveryApiPath(req);
  const classification = classifyRegistryDeliveryOp(req.method, apiPath);
  if (!classification.eligible) {
    next();
    return;
  }

  const rawBody = req.body as Record<string, unknown> | undefined;
  const delivery = rawBody?.[REGISTRY_DELIVERY_BODY_FIELD] as RegistryDeliveryEnvelope | undefined;
  scrubDeliveryField(rawBody);

  if (!delivery) {
    next();
    return;
  }

  try {
    RegistryDeliveryService.getInstance().parseAttestation(delivery.attestation);
    req.registryDeliveryEnvelope = delivery;

    const abortController = new AbortController();
    req.registryDeliveryAbortController = abortController;

    const onReqAborted = () => {
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
    };
    const onResClose = () => {
      if (!res.writableEnded && !abortController.signal.aborted) {
        abortController.abort();
      }
    };

    let abortListenersDetached = false;
    const detachAbortListeners = () => {
      if (abortListenersDetached) return;
      abortListenersDetached = true;
      req.off('aborted', onReqAborted);
      res.off('close', onResClose);
    };

    req.on('aborted', onReqAborted);
    res.on('close', onResClose);

    let operationEvidenceRecorded = false;
    const recordOperationEvidence = () => {
      if (operationEvidenceRecorded) return;
      operationEvidenceRecorded = true;
      const stack = resolveDeliveryStack(req.method, apiPath, rawBody) ?? classification.stack;
      if (!stack || !classification.stage) return;
      recordRegistryDeliveryEvent({
        deliverySourceId: delivery.deliverySourceId,
        eventType: abortController.signal.aborted ? 'operation_aborted' : 'operation_completed',
        stack,
        op: classification.stage,
        attestationJti: attestationJtiFromToken(delivery.attestation),
        prepIdSha256: delivery.prepId ? hashPrepId(delivery.prepId) : null,
      });
    };

    res.once('finish', () => {
      recordOperationEvidence();
      detachAbortListeners();
    });
    res.once('close', detachAbortListeners);

    const stack = resolveDeliveryStack(req.method, apiPath, rawBody) ?? classification.stack;
    if (!stack || !classification.stage) {
      detachAbortListeners();
      res.status(400).json({ error: 'Invalid registry delivery route classification' });
      return;
    }

    runWithRegistryDeliveryContext(
      {
        envelope: delivery,
        nodeId: req.nodeId,
        stack,
        stage: classification.stage,
        service: classification.service,
        abortSignal: abortController.signal,
      },
      () => next(),
    );
  } catch {
    res.status(400).json({ error: 'Invalid registry delivery envelope' });
  }
}
