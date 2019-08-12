const LicenseKey = require('../lib/license-key');
const mongoose = require('mongoose');
const connectToDatabase = require('../helpers/db');
const LicenseKeyModel = require('../models/license-key');
const Plan = require('../models/license-key-plan');
const response = require('../helpers/response');
const _ = require('lodash');
const moment = require('moment');
const LicensingResponses = require('../helpers/licensing-reponses');


/**
 * Create a new License key
 * @param event
 * @param context
 * @param callback
 * @returns {*}
 */
module.exports.create = async (event, context) => {

  context.callbackWaitsForEmptyEventLoop = false;

  let data = {}

  try {
    data = JSON.parse(event.body);
  } catch (e) {
    return response.negotiate(e);
  }

  if (!data || !data.serviceId || data.serviceId === 'undefined') {
    console.error('Validation Failed');
    return response.badRequest("Missing required parameters");
  }

  try {
    await connectToDatabase();
    const plan = await Plan.findOne({
      $or:[
        {_id: data.plan},
        {alias: data.plan}
      ]
    });
    if(!plan) return response.badRequest("Invalid plan")

    const key = LicenseKey().generate(data.serviceId);
    const license = await LicenseKeyModel.create(_.merge(data, {plan: plan}, {value: key}));
    return response.ok(license);
  }catch (e) {
    return response.negotiate(e)
  }
};

/**
 * Query License keys
 * @param event
 * @param context
 * @param callback
 * @returns {Promise<T>}
 */
module.exports.query = async(event, context) => {

  context.callbackWaitsForEmptyEventLoop = false;

  let options = {
    page: _.get(event, 'queryStringParameters.page') ? parseInt(event.queryStringParameters.page) : 1,
    limit: _.get(event, 'queryStringParameters.limit') ? parseInt(event.queryStringParameters.limit) : 25,
    sort: _.get(event, 'queryStringParameters.sort') ? event.queryStringParameters.sort : {createdAt: -1}
  }

  const criteria = {
    status: _.get(event, 'queryStringParameters.status'),
    serviceId: _.get(event, 'queryStringParameters.serviceId'),
    plan: _.get(event, 'queryStringParameters.plan'),
    identifier: _.get(event, 'queryStringParameters.identifier')
  }

  console.log("criteria => ", _.pickBy(criteria, _.identity))

  try {
    await connectToDatabase();
    const results = await LicenseKeyModel.paginate(_.pickBy(criteria, _.identity), options);
    return response.ok(results);
  }catch (e) {
    return response.negotiate(e);
  }
};

/**
 * Find a specific key using its id or value
 * @param event
 * @param context
 * @param callback
 * @returns {Promise<T>}
 */
module.exports.findOne = async (event, context) => {

  context.callbackWaitsForEmptyEventLoop = false;

  try{
    await connectToDatabase();
    const identifier = _.get(event, 'pathParameters.id');
    let criteria = {};
    if(mongoose.Types.ObjectId.isValid(identifier)) {
      criteria._id = identifier
    }else{
      criteria.value = identifier;
    }
    const license =  await LicenseKeyModel.findOne(criteria);
    if(!license) return response.negotiate(LicensingResponses.LICENSE_NOT_FOUND);
    return response.ok(license);
  }catch (e) {
    return response.negotiate(e);
  }
};


/**
 * Activate a specific key
 * @param event
 * @param context
 * @param callback
 * @returns {Promise<T>}
 */
module.exports.activate = async(event, context) => {

  context.callbackWaitsForEmptyEventLoop = false;

  let data = {}

  try {
    data = JSON.parse(event.body);
  } catch (e) {}

  if(!data.identifier) return response.negotiate(LicensingResponses.MISSING_PARAMETERS);
  const value = _.get(event, 'pathParameters.value');

  try {
    await connectToDatabase();
    const license = await LicenseKeyModel.findOne({value: value}).populate('plan');
    if(!license) return response.negotiate(LicensingResponses.LICENSE_NOT_FOUND);
    if(!license.plan) return response.negotiate(LicensingResponses.NO_PLAN_TO_LICENSE);
    if(license.activatedAt || license.identifier) return response.negotiate(LicensingResponses.LICENSE_ALREADY_ACTIVE);

    // Check if there's an existing active license for the given identifier and serviceId.
    // If that's the case, we will need to extend the newly activated license's expiry based
    // on the existing license's remaining time
    const existingActiveKeyForIdentifier = await LicenseKeyModel.findOne({
      identifier: data.identifier,
      serviceId: license.serviceId,
      expiresAt: {
        $gte: new Date().getTime()
      }
    })

    let now = new Date().getTime();
    let licenseStartTime = existingActiveKeyForIdentifier ? existingActiveKeyForIdentifier.expiresAt : now;

    license.identifier = data.identifier;
    license.activatedAt = now;

    // Create expiresAt based on the plan
    let planDurationParts = license.plan.duration.split(" "); // ex. `15 years` will be [0] = 15, [1] => `years`
    let expiresAt = moment(licenseStartTime).add(planDurationParts[0],planDurationParts[1]);
    license.expiresAt = expiresAt;

    // Finally, add extra info if provided
    if(data.extra && _.isObject(data.extra)) {
      license.extra = data.extra;
    }

    // Expire the existing license if needed
    if(existingActiveKeyForIdentifier) {
      existingActiveKeyForIdentifier.expiresAt = now;
      await existingActiveKeyForIdentifier.save();
    }

    // Save new License
    await license.save();

    return response.ok(license);
  }catch (e) {
    return response.negotiate(e);
  }
};


/**
 * Validate a specific key
 * @param event
 * @param context
 * @param callback
 * @returns {Promise<T>}
 */
module.exports.validate = async (event, context) => {

  context.callbackWaitsForEmptyEventLoop = false;

  let data = {}

  try {
    data = JSON.parse(event.body);
  } catch (e) {}

  if(!data.identifier) return response.negotiate(LicensingResponses.MISSING_PARAMETERS);
  const value = _.get(event, 'pathParameters.value');

  try {
    await connectToDatabase();
    const license = await LicenseKeyModel.findOne({value: value});
    if(!license) return response.negotiate(LicensingResponses.LICENSE_NOT_FOUND);
    if(!license.activatedAt) return response.negotiate(LicensingResponses.LICENSE_NOT_ACTIVE);
    if(license.identifier !== data.identifier) return response.negotiate(LicensingResponses.IDENTIFIER_MISMATCH);
    if(license.expiresAt < new Date().getTime()) return response.negotiate(LicensingResponses.LICENSE_EXPIRED);
    return response.ok(license);
  }catch (e) {
    console.log(e);
    return response.negotiate(e);
  }
};
