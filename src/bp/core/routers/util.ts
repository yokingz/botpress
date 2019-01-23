import { Logger } from 'botpress/sdk'
import { checkRule } from 'common/auth'
import { WorkspaceService } from 'core/services/workspace-service'
import crypto from 'crypto'
import { NextFunction, Request, Response } from 'express'
import Joi from 'joi'

import { RequestWithUser } from '../misc/interfaces'
import AuthService from '../services/auth/auth-service'
import { AssertionError, ProcessingError, UnauthorizedAccessError } from '../services/auth/errors'

export const asyncMiddleware = ({ logger }: { logger: Logger }) => (
  fn: (req: Request, res: Response, next?: NextFunction) => Promise<any>
) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(err => {
    if (!err.skipLogging && !process.IS_PRODUCTION) {
      logger.attachError(err).debug(`Async request error ${err.message}`)
    }

    next(err)
  })
}

export const validateRequestSchema = (property: string, req: Request, schema: Joi.AnySchema) => {
  const result = Joi.validate(req[property], schema)

  if (result.error) {
    throw new AssertionError(result.error.message)
  }

  Object.assign(req[property], result.value)
}

export const validateBodySchema = (req: Request, schema: Joi.AnySchema) => validateRequestSchema('body', req, schema)

export const success = (res: Response, message: string = 'Success', payload = {}) => {
  res.json({
    status: 'success',
    message,
    payload
  })
}

export const checkTokenHeader = (authService: AuthService, audience?: string) => async (
  req: RequestWithUser,
  res: Response,
  next: NextFunction
) => {
  if (!req.headers.authorization) {
    return next(new UnauthorizedAccessError('No Authorization header'))
  }

  const [scheme, token] = req.headers.authorization.split(' ')
  if (scheme.toLowerCase() !== 'bearer') {
    return next(new UnauthorizedAccessError(`Unknown scheme ${scheme}`))
  }

  if (!token) {
    return next(new UnauthorizedAccessError('Missing authentication token'))
  }

  try {
    const user = await authService.checkToken(token, audience)

    if (!user) {
      return next(new UnauthorizedAccessError('Invalid authentication token'))
    }

    req.user = user
  } catch (err) {
    return next(new UnauthorizedAccessError('Invalid authentication token'))
  }

  next()
}

const generateGravatarURL = (email: string): string => {
  const hash = crypto
    .createHash('md5')
    .update(email)
    .digest('hex')

  return `https://www.gravatar.com/avatar/${hash}`
}

export const loadUser = (authService: AuthService) => async (req: Request, res: Response, next: Function) => {
  const reqWithUser = req as RequestWithUser
  const { user } = reqWithUser
  if (!user) {
    throw new ProcessingError('No user property in the request')
  }

  const authUser = await authService.findUserByEmail(user.email)
  if (!authUser) {
    throw new UnauthorizedAccessError('Unknown user ID')
  }

  reqWithUser.authUser = {
    ...authUser,
    picture: generateGravatarURL(authUser.email),
    fullName: [authUser.firstname, authUser.lastname].filter(Boolean).join(' ')
  }

  next()
}

const getParam = (req: Request, name: string, defaultValue?: any) =>
  req.params[name] || req.body[name] || req.query[name]

class PermissionError extends AssertionError {
  constructor(message: string) {
    super('Permission check error: ' + message)
  }
}

export const needPermissions = (workspaceService: WorkspaceService) => (operation: string, resource: string) => async (
  req: RequestWithUser,
  res: Response,
  next: NextFunction
) => {
  const email = req.user && req.user.email
  const user = await workspaceService.findUser({ email })
  if (!user) {
    throw new Error(`User "${email}" does not exists`)
  }

  const role = await workspaceService.getRoleForUser(user.email)

  if (!role || checkRule(role.rules, operation, resource)) {
    next(new PermissionError(`user does not have sufficient permissions to ${operation} ${resource}`))
    return
  }

  next()
}