// @generated
#![allow(unused_imports, dead_code, unused_variables)]
use crate::ApiCallError;
use crate::entities::Entity;
use crate::services::{PostService, GetService, PutService, DeleteService, Service, Executor, ExtraServiceParams};
use crate::bindings::rest_client::HttpMethod;
use crate::services::hidden::Nothing;
use crate::entities::generated::usage::UsageTestAssignmentIn;
use crate::entities::generated::usage::UsageTestAssignmentOut;
use crate::entities::generated::usage::UsageTestParticipationIn;
pub struct UsageTestAssignmentService;

crate::service_impl!(declare, UsageTestAssignmentService, "usage/usagetestassignmentservice", 3);
crate::service_impl!(POST, UsageTestAssignmentService, UsageTestAssignmentIn, UsageTestAssignmentOut);
crate::service_impl!(PUT, UsageTestAssignmentService, UsageTestAssignmentIn, UsageTestAssignmentOut);


pub struct UsageTestParticipationService;

crate::service_impl!(declare, UsageTestParticipationService, "usage/usagetestparticipationservice", 3);
crate::service_impl!(POST, UsageTestParticipationService, UsageTestParticipationIn, ());
