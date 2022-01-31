import { autoinject } from "aurelia-framework";
import { RouteConfig } from "aurelia-router";
import { IBaseWizardStage } from "../../dealWizardTypes";
import { WizardService, IWizardState, WizardErrors } from "../../../services/WizardService";
import { IDealRegistrationData, IProposalLead } from "entities/DealRegistrationData";
import { ValidationController } from "aurelia-validation";
import { proposalLeadValidationRules, validateWizardState } from "../../validation";

@autoinject
export class OpenProposalProposalLeadStage implements IBaseWizardStage {
  public wizardManager: any;
  public wizardState: IWizardState<IDealRegistrationData>;
  public errors: WizardErrors<IProposalLead> = {};

  private form: ValidationController;

  constructor(public wizardService: WizardService, validationFactory: ValidationControllerFactory) {
    this.form = validationFactory.createForCurrentScope();
  }

  activate(_params: unknown, routeConfig: RouteConfig): void {
    this.wizardManager = routeConfig.settings.wizardManager;
  }

  attached(): void {
    this.wizardState = this.wizardService.getWizardState(this.wizardManager);
    this.wizardService.registerStageValidateFunction(this.wizardManager, this.validate.bind(this));
  }

  async validate(): Promise<boolean> {
    const [formResult, errors] = await validateWizardState(this.form, this.wizardState.registrationData.proposalLead, proposalLeadValidationRules);
    this.errors = errors;

    this.wizardService.updateStageValidity(this.wizardManager, formResult.valid);

    return formResult.valid;
  }
}
